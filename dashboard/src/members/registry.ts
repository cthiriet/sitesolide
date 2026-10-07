/**
 * The members registry: who the super admin invited, and their role on each
 * project. Held by the steward in `/var/lib/sitesolide-steward/members.json`,
 * root 0600, written atomically like the tokens' `team.json`.
 *
 * **The registry is the steward's, not the dashboard's**, for the reason the
 * tokens' is: a registry the dashboard could write would let a compromised
 * dashboard make anyone a Project admin of anything. The steward reads it on
 * every decision, so a role taken away holds from the next request, and a
 * member removed is refused at their next write, session in hand.
 *
 * Pure: the registry comes in as a value, a new one goes out; the clock is a
 * parameter. Reading and writing the file belong to system.ts.
 */
import { cleanEmail, maySignIn } from "../../borrowed/sharing";
import { isValidSlug } from "../../borrowed/manifest";
import { reservedReason } from "../control/policy";
import { may } from "./powers";
import { MAX_MEMBERS, MAX_ROLES, ROLES, type MemberView, type Role, type Roles } from "./protocol";

export type MemberRecord = MemberView;

export type Registry = { members: MemberRecord[] };

export const EMPTY_REGISTRY: Registry = { members: [] };

export type Refusal = { refusal: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Developer and Project admin restart their projects' services; a Viewer only looks. See powers.ts. */
export function mayRestart(role: Role | null): boolean {
  return may(role, "restart");
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A record as the file holds it: `create` may be missing, from a registry written before the right existed. */
function isRecord(value: unknown): value is Omit<MemberRecord, "create"> & { create?: boolean } {
  if (!isObject(value)) return false;
  const { email, roles, invitedBy, createdAt, updatedAt } = value;
  if (typeof email !== "string" || cleanEmail(email) !== email) return false;
  if (!isObject(roles) || Object.keys(roles).length > MAX_ROLES) return false;
  for (const [slug, role] of Object.entries(roles)) if (!isValidSlug(slug) || !isRole(role)) return false;
  if (value.create !== undefined && typeof value.create !== "boolean") return false;
  return typeof invitedBy === "string" && invitedBy.length <= 254 && isDate(createdAt) && isDate(updatedAt);
}

/**
 * The registry's file, read. A missing file is nobody. A file that does not
 * read is not guessed at: every member is refused until a human looks, the
 * safe failure for a list of who may do what.
 */
export function readRegistry(text: string | null): Registry | { unreadable: string } {
  if (text === null) return { members: [] };
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "members.json is not JSON" };
  }
  if (!isObject(object) || !Array.isArray(object.members)) return { unreadable: "members.json does not have the expected shape" };
  if (!object.members.every(isRecord)) return { unreadable: "a member of members.json does not have the expected shape" };
  const emails = new Set(object.members.map((member) => (member as MemberRecord).email));
  if (emails.size !== object.members.length) return { unreadable: "members.json names one email twice" };
  // A member written before the create right holds none.
  return { members: (object.members as MemberRecord[]).map((member) => ({ ...member, create: member.create === true })) };
}

export function encodeRegistry(registry: Registry): string {
  return `${JSON.stringify({ members: registry.members }, null, 2)}\n`;
}

export function findMember(registry: Registry, email: string): MemberRecord | null {
  return registry.members.find((member) => member.email === email) ?? null;
}

/** The role this email holds on this project, or null. */
export function roleOf(registry: Registry, email: string, slug: string): Role | null {
  const member = findMember(registry, email);
  if (member === null || !Object.hasOwn(member.roles, slug)) return null;
  return member.roles[slug] ?? null;
}

/** A copy, so that nothing handed out can change the registry it came from. */
export function viewOf(record: MemberRecord): MemberView {
  return { ...record, roles: { ...record.roles } };
}

/** Sorted by email: the page and the CLI list them that way. */
export function views(registry: Registry): MemberView[] {
  return [...registry.members].sort((a, b) => a.email.localeCompare(b.email)).map(viewOf);
}

/** `blog: developer, shop: viewer`, for the journal and the CLI. */
export function rolesText(roles: Roles): string {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "no project" : entries.map(([slug, role]) => `${slug}: ${role}`).join(", ");
}

/** The roles, and the create right when held: `blog: developer; may create projects`. */
export function rightsText(roles: Roles, create: boolean): string {
  return create ? `${rolesText(roles)}; may create projects` : rolesText(roles);
}

// --- what the super admin asks for -----------------------------------------------

/** What the steward knows of the machine when it judges a role: the zone, and which projects exist. */
export type Machine = { zone: string; exists: (slug: string) => boolean };

/**
 * The roles as a request sends them, or the refusal. Every project must be
 * deployed, and none of the platform's own: the dashboard, the portal and the
 * others are the machine, which stays the super admin's. A role a project no
 * longer deployed still carries is kept when it is not touched, so that
 * removing a project does not silently rewrite who may see its next deploy.
 */
export function readRoles(value: unknown, machine: Machine, kept: Roles = {}): Roles | Refusal {
  if (!isObject(value)) return { refusal: "roles: an object of project slugs to viewer, developer or admin" };
  const entries = Object.entries(value);
  if (entries.length > MAX_ROLES) return { refusal: `a member may hold a role on ${MAX_ROLES} projects at most` };
  const roles: Roles = {};
  for (const [slug, role] of entries) {
    if (!isValidSlug(slug)) return { refusal: `roles: ${JSON.stringify(slug).slice(0, 70)} is not a project slug` };
    const reserved = reservedReason(slug, machine.zone);
    if (reserved !== null) return { refusal: `roles: ${slug} belongs to the platform, which stays the super admin's` };
    if (!isRole(role)) return { refusal: `roles: ${slug}: the role is viewer, developer or admin` };
    const unchanged = Object.hasOwn(kept, slug) && kept[slug] === role;
    if (!unchanged && !machine.exists(slug)) return { refusal: `roles: ${slug} is not deployed on this machine` };
    roles[slug] = role;
  }
  return roles;
}

/**
 * An address as the super admin typed it, cleaned by the portal's own rule, or
 * the refusal. With allowed domains, it must be at one of them, or one of the
 * portal's admin emails: the portal would turn anyone else away at sign-in,
 * and an invitation nobody can use is a mistake to say now, not at their
 * first attempt.
 */
export function judgeEmail(value: unknown, settings: { allowedDomains: string[]; admins: string[] }): string | Refusal {
  const email = cleanEmail(value);
  if (email === null) return { refusal: "email: a work address the portal accepts, like alice@acme.com" };
  if (!maySignIn(email, settings.allowedDomains, settings.admins)) {
    return { refusal: `${email} cannot sign in here: the portal admits only ${settings.allowedDomains.join(", ")} (OIDC_ALLOWED_DOMAINS)` };
  }
  return email;
}

function sameRoles(a: Roles, b: Roles): boolean {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
}

export type Put = { registry: Registry; member: MemberView; change: "invite" | "role" | "none" };

/**
 * A member invited with these roles, or their roles replaced whole: the
 * request names every project they keep. `invitedBy` is the steward's to say,
 * from who asked, never from the request. `create`, the right to create
 * projects, is the super admin's to give or take; undefined keeps it as it
 * stands, false for someone new.
 */
export function putMember(registry: Registry, email: string, roles: Roles, invitedBy: string, now: number, create?: boolean): Put | Refusal {
  const found = findMember(registry, email);
  if (found === null) {
    if (registry.members.length >= MAX_MEMBERS) return { refusal: `${MAX_MEMBERS} members at most: remove the ones who left` };
    // Someone invited sees their projects, or creates their own: with neither, there is nothing to sign in to.
    if (Object.keys(roles).length === 0 && create !== true) return { refusal: "roles: give them a role on one project at least, or the right to create projects" };
    const record: MemberRecord = { email, roles: { ...roles }, create: create ?? false, invitedBy, createdAt: now, updatedAt: now };
    return { registry: { members: [...registry.members, record] }, member: viewOf(record), change: "invite" };
  }
  const right = create ?? found.create;
  if (sameRoles(found.roles, roles) && right === found.create) return { registry, member: viewOf(found), change: "none" };
  const changed: MemberRecord = { ...found, roles: { ...roles }, create: right, updatedAt: now };
  return {
    registry: { members: registry.members.map((member) => (member.email === email ? changed : member)) },
    member: viewOf(changed),
    change: "role",
  };
}

/** A member taken off the registry. Their sessions fall with them: see sessions.ts. */
export function removeMember(registry: Registry, value: unknown): { registry: Registry; member: MemberView } | Refusal {
  const email = cleanEmail(value);
  if (email === null) return { refusal: "email: the address of the member to remove" };
  const found = findMember(registry, email);
  if (found === null) return { refusal: `${email} is not a member` };
  return { registry: { members: registry.members.filter((member) => member.email !== email) }, member: viewOf(found) };
}

// --- what a Project admin asks for, on their project alone ------------------------

/**
 * One role on one project, given by a Project admin: a person invited with
 * that role alone, or a member's role on that project set, their other
 * projects untouched. `invitedBy` names the Project admin for someone new; a
 * member already there keeps who invited them. The caller has judged that
 * the Project admin may give this role here (powers.ts, `mayGrant`).
 */
export function putProjectRole(registry: Registry, email: string, slug: string, role: Role, invitedBy: string, now: number): Put | Refusal {
  const found = findMember(registry, email);
  if (found === null) return putMember(registry, email, { [slug]: role }, invitedBy, now);
  if (!Object.hasOwn(found.roles, slug) && Object.keys(found.roles).length >= MAX_ROLES) {
    return { refusal: `a member may hold a role on ${MAX_ROLES} projects at most` };
  }
  return putMember(registry, email, { ...found.roles, [slug]: role }, found.invitedBy, now);
}

/**
 * A member's role on one project taken away by its Project admin. Their last
 * one gone, they are no member any more: a member with no project sees
 * nothing, and is removed rather than kept as an empty name, unless they hold
 * the create right, which the super admin gave them and a Project admin does
 * not take away.
 */
export function removeProjectRole(
  registry: Registry,
  value: unknown,
  slug: string,
  now: number,
): { registry: Registry; member: MemberView; removed: boolean } | Refusal {
  const email = cleanEmail(value);
  if (email === null) return { refusal: "email: the address of the member" };
  const found = findMember(registry, email);
  if (found === null || !Object.hasOwn(found.roles, slug)) return { refusal: `${email} holds no role on ${slug}` };
  const roles = { ...found.roles };
  delete roles[slug];
  if (Object.keys(roles).length === 0 && !found.create) {
    return { registry: { members: registry.members.filter((member) => member.email !== email) }, member: viewOf(found), removed: true };
  }
  const changed: MemberRecord = { ...found, roles, updatedAt: now };
  return { registry: { members: registry.members.map((member) => (member.email === email ? changed : member)) }, member: viewOf(changed), removed: false };
}

// --- what a member creates ---------------------------------------------------------

/**
 * A project a member created, through a token of their own that may create:
 * they become its Project admin, whatever role a registry edited by hand gave
 * them there before. Their other projects and their create right untouched.
 * The steward records it at the start of the project's first deployment,
 * when it records the token's ownership, before anything is written on the
 * machine: a first deployment that fails half way stays theirs to deploy
 * again.
 */
export function recordCreation(registry: Registry, email: string, slug: string, now: number): Put | Refusal {
  const found = findMember(registry, email);
  if (found === null) return { refusal: `${email} is no longer a member of this dashboard` };
  if (!Object.hasOwn(found.roles, slug) && Object.keys(found.roles).length >= MAX_ROLES) {
    return { refusal: `a member may hold a role on ${MAX_ROLES} projects at most` };
  }
  return putMember(registry, email, { ...found.roles, [slug]: "admin" }, found.invitedBy, now);
}
