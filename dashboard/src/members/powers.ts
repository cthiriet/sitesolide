/**
 * What a person may do on a project, by role: the steward's one table, and
 * the refusals it says. Pure.
 *
 * | Role | Powers |
 * |---|---|
 * | Can open (`visitor`) | none here: they open the site when its general access is restricted, and see nothing in the dashboard |
 * | Viewer | none: they see the project, the dashboard filters what they see |
 * | Developer | restart; list the secret files, names and metadata; write: create a declared file, set, replace or remove a variable, replace a whole file. Never a value read back. Deploy it with a token of their own |
 * | Admin | everything a Developer has, and read a value or a file back, restore a file's previous version, general access, people with access, a role at most their own, backups and their restore. A token of theirs may also deploy it in the open, declare a domain for it, and let it reach outside hosts |
 *
 * Nothing here is anyone's for the platform's own projects, the dashboard,
 * the portal and the others, nor for a file the machine keeps for root: those
 * stay the owner's (`machineRefusal`).
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
  | "access"
  | "backups"
  | "deploy"
  | "deploy.public"
  | "deploy.domain"
  | "deploy.outbound";

/**
 * `deploy` is what a person's own token does on a project: write its code,
 * which a Developer already trusts with its secrets. The three others are
 * what a token's scope may add to a deployment (src/control/protocol.ts,
 * `Scope`): a site in the open is general access turned public, and a domain
 * and the network outside widen what the project is; each is an Admin's, as
 * general access is.
 */
const POWERS: Readonly<Record<Role, readonly Power[]>> = {
  visitor: [],
  viewer: [],
  developer: ["restart", "secrets.list", "secrets.write", "deploy"],
  admin: [
    "restart",
    "secrets.list",
    "secrets.write",
    "secrets.read",
    "secrets.restore",
    "door",
    "access",
    "backups",
    "deploy",
    "deploy.public",
    "deploy.domain",
    "deploy.outbound",
  ],
};

export function may(role: Role | null, power: Power): boolean {
  return role !== null && POWERS[role].includes(power);
}

/** Developer and Admin restart their projects' services; a Viewer only looks. */
export function mayRestart(role: Role | null): boolean {
  return may(role, "restart");
}

/**
 * Which powers ask for the person's own unlock, the ten minutes a forced
 * sign-in at the provider opens: whatever reads or writes a secret, changes
 * general access, puts a project's data back. Giving someone a role above
 * Can open asks for it too (src/access/rules.ts); a restart, removing
 * someone, and giving Can open do not, as for the owner, whose session
 * alone does them.
 */
export function needsUnlock(power: Power): boolean {
  return power === "secrets.write" || power === "secrets.read" || power === "secrets.restore" || power === "door" || power === "backups";
}

const ROLE_NAMES: Readonly<Record<Role, string>> = { visitor: "Can open", viewer: "a Viewer", developer: "a Developer", admin: "an Admin" };

const WHAT: Readonly<Record<Power, string>> = {
  restart: "restarting its service takes a Developer or an Admin",
  "secrets.list": "its secret files are for a Developer or an Admin",
  "secrets.write": "changing its secrets takes a Developer or an Admin",
  "secrets.read": "reading a value back takes an Admin: a Developer sets, replaces and removes values, and never reads one",
  "secrets.restore": "putting a previous version back takes an Admin",
  door: "changing its general access takes an Admin",
  access: "its people with access are its Admin's",
  backups: "its backups and their restore are an Admin's",
  deploy: "deploying it takes a Developer or an Admin",
  "deploy.public": "deploying it in the open, its general access public, takes an Admin",
  "deploy.domain": "declaring a domain for it takes an Admin",
  "deploy.outbound": "letting it reach outside hosts takes an Admin",
};

/** The refusal, in English, shown as it stands. */
export function powerRefusal(email: string, role: Role | null, slug: string, power: Power): string {
  if (role === null) return `${email} holds no role on ${slug}`;
  if (role === "visitor") return `${email} can open ${slug} and nothing more: ${WHAT[power]}`;
  return `${email} is ${ROLE_NAMES[role]} on ${slug}: ${WHAT[power]}`;
}

/** What the journal says of a refusal by role: never more than the role. */
export function roleDetail(role: Role | null): string {
  return role === null ? "no role" : `role ${role}`;
}

/**
 * The files of the machine itself, whoever holds a role where they sit: the
 * dashboard's and the portal's settings, and any file the steward lays for
 * root. A role is never given on the platform's projects (src/access/rules.ts
 * refuses it), and this is the second lock, judged on the file itself.
 */
export function machineRefusal(slug: string, file: { name: string; expected: { owner: string } } | null, zone: string): string | null {
  if (reservedReason(slug, zone) !== null) return `${slug} belongs to the platform, which stays the owner's`;
  if (file === null) return null;
  if (file.expected.owner === "root" || file.name === "dashboard.env" || file.name === "portal.env") {
    return `${file.name} belongs to the machine, which stays the owner's`;
  }
  return null;
}
