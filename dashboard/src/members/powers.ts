/**
 * What a member may do on a project, by role: the steward's one table, and
 * the refusals it says. Pure.
 *
 * | Role | Powers |
 * |---|---|
 * | Viewer | none: they see the project, the dashboard filters what they see |
 * | Developer | restart; list the secret files, names and metadata; write: create a declared file, set, replace or remove a variable, replace a whole file. Never a value read back |
 * | Project admin | everything a Developer has, and read a value or a file back, restore a file's previous version, the portal door, sharing, guests, backups and their restore, and the project's members, a role at most their own |
 *
 * Nothing here is a member's for the platform's own projects, the dashboard,
 * the portal and the others, nor for a file the machine keeps for root: those
 * stay the super admin's (`machineRefusal`).
 *
 * The dashboard reads this table too, to offer what the steward will accept;
 * the steward is the one that refuses.
 */
import { reservedReason } from "../control/policy";
import type { Role } from "./protocol";

export type Power =
  | "restart"
  | "secrets.list"
  | "secrets.write"
  | "secrets.read"
  | "secrets.restore"
  | "door"
  | "sharing"
  | "guests"
  | "backups"
  | "members";

const POWERS: Readonly<Record<Role, readonly Power[]>> = {
  viewer: [],
  developer: ["restart", "secrets.list", "secrets.write"],
  admin: ["restart", "secrets.list", "secrets.write", "secrets.read", "secrets.restore", "door", "sharing", "guests", "backups", "members"],
};

/** The narrowest first: a role grants what every narrower one does. */
const RANK: Readonly<Record<Role, number>> = { viewer: 0, developer: 1, admin: 2 };

export function may(role: Role | null, power: Power): boolean {
  return role !== null && POWERS[role].includes(power);
}

/**
 * Which powers ask for the member's own unlock, the ten minutes a forced sign-in
 * at the provider opens: whatever reads or writes a secret, takes a door off,
 * puts a project's data back, or hands someone a role. A restart, sharing and
 * guests do not, as for the super admin, whose session alone does them.
 */
export function needsUnlock(power: Power): boolean {
  return power === "secrets.write" || power === "secrets.read" || power === "secrets.restore" || power === "door" || power === "backups" || power === "members";
}

/** May a member holding `own` on a project give `granted` on it? A Project admin alone, and never more than their own. */
export function mayGrant(own: Role | null, granted: Role): boolean {
  return may(own, "members") && RANK[granted] <= RANK[own!];
}

const ROLE_NAMES: Readonly<Record<Role, string>> = { viewer: "a viewer", developer: "a developer", admin: "a project admin" };

const WHAT: Readonly<Record<Power, string>> = {
  restart: "restarting its service takes a developer or a project admin",
  "secrets.list": "its secret files are for a developer or a project admin",
  "secrets.write": "changing its secrets takes a developer or a project admin",
  "secrets.read": "reading a value back takes a project admin: a developer sets, replaces and removes values, and never reads one",
  "secrets.restore": "putting a previous version back takes a project admin",
  door: "turning its portal on or off takes a project admin",
  sharing: "changing who may open it takes a project admin",
  guests: "giving or revoking guest access takes a project admin",
  backups: "its backups and their restore are a project admin's",
  members: "giving people a role on it takes a project admin",
};

/** The refusal, in English, shown as it stands. */
export function powerRefusal(email: string, role: Role | null, slug: string, power: Power): string {
  if (role === null) return `${email} holds no role on ${slug}`;
  return `${email} is ${ROLE_NAMES[role]} on ${slug}: ${WHAT[power]}`;
}

/** What the journal says of a refusal by role: never more than the role. */
export function roleDetail(role: Role | null): string {
  return role === null ? "no role" : `role ${role}`;
}

/**
 * The files of the machine itself, whoever holds a role where they sit: the
 * dashboard's and the portal's settings, and any file the steward lays for
 * root. A member's role is never on the platform's projects (registry.ts
 * refuses it), and this is the second lock, judged on the file itself.
 */
export function machineRefusal(slug: string, file: { name: string; expected: { owner: string } } | null, zone: string): string | null {
  if (reservedReason(slug, zone) !== null) return `${slug} belongs to the platform, which stays the super admin's`;
  if (file === null) return null;
  if (file.expected.owner === "root" || file.name === "dashboard.env" || file.name === "portal.env") {
    return `${file.name} belongs to the machine, which stays the super admin's`;
  }
  return null;
}
