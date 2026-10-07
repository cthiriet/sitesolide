/**
 * Who may give whom which role, on which project: the steward's one set of
 * rules for access, whoever asks, the owner over SSH or in the dashboard, an
 * admin of the project through their session, a token through the control
 * API. Pure.
 *
 * | Rule | Why |
 * |---|---|
 * | a domain is `visitor` only | everyone at acme.com opens the site; nobody at it administers anything for being there |
 * | a person inside the company's domains may hold any role | they sign in with their company account, to the site and to the dashboard |
 * | a person outside them, or anyone without company sign-in, is `visitor` with a password | the portal could not tell who they are otherwise; the password is theirs, for one site, until its expiry |
 * | an admin grants at most their own role, on their project alone | a role handed on is never more than the one that hands it |
 * | the owner grants anything | the machine is theirs |
 * | a token grants `visitor` alone, never a password | what a token did before, sharing: whoever holds one is not the one who chose the company's people |
 *
 * And the narrowing nobody needs leave for: removing anyone, lowering anyone
 * the granter may grant, as soon as they may manage the project.
 *
 * Whether a person may manage a project at all, an admin's role there, a
 * token's reach, is the caller's to judge first; these rules then judge the
 * change itself.
 */
import { atLeast, rank, type Role } from "../../borrowed/access";
import { domainOf, maySignIn } from "../../borrowed/sharing";
import { reservedReason } from "../control/policy";
import { DEFAULT_PASSWORD_DURATION_S, PASSWORD_DURATIONS_S, type SignInSettings } from "./protocol";
import { findEntry, readWho, type Entry, type Refusal, type Registry, type Who } from "./registry";

/** Who asks for a change. */
export type Granter =
  | { kind: "owner" }
  /** A person through their dashboard session: their role on the project. */
  | { kind: "admin"; email: string; role: Role | null }
  /** A token, the person it belongs to (null for the owner's) and their role on the project. */
  | { kind: "token"; id: string; email: string | null; role: Role | null };

/** What the steward knows of the machine when it judges: the zone, and which projects are deployed. */
export type Machine = { zone: string; exists: (slug: string) => boolean };

/** The granter's name in the registry and the journal. */
export function granterName(granter: Granter): string {
  return granter.kind === "owner" ? "owner" : granter.kind === "admin" ? granter.email : `token:${granter.id}`;
}

/** The highest role this granter may give on the project, null when they manage nothing there. */
export function grantCeiling(granter: Granter): Role | null {
  if (granter.kind === "owner") return "admin";
  if (granter.kind === "admin") return atLeast(granter.role, "admin") ? granter.role : null;
  // A token: the owner's, or a person's who is admin there, gives `visitor` alone.
  if (granter.email !== null && !atLeast(granter.role, "admin")) return null;
  return "visitor";
}

/** Is this person signed in by the company's account: a provider set up, and their domain one it admits? */
export function signsInWithAccount(email: string, signIn: SignInSettings): boolean {
  return signIn.configured && maySignIn(email, signIn.allowedDomains, signIn.admins);
}

/** The project's slug, refused for the platform's own and for one not deployed (a change to an existing entry excepted). */
export function projectRefusal(slug: unknown, machine: Machine, existing: boolean): Refusal | null {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(slug)) return { refusal: "slug: a project's slug", code: "invalid" };
  if (reservedReason(slug, machine.zone) !== null) return { refusal: `${slug} belongs to the platform, which stays the owner's`, code: "out-of-scope" };
  if (!existing && !machine.exists(slug)) return { refusal: `${slug} is not deployed on this machine`, code: "not-found" };
  return null;
}

/** A password access's duration as a request names it: one of the four offered, 7 days when absent. */
export function readDuration(value: unknown): number | null | Refusal {
  if (value === undefined) return DEFAULT_PASSWORD_DURATION_S;
  if ((PASSWORD_DURATIONS_S as readonly (number | null)[]).includes(value as number | null)) return value as number | null;
  return { refusal: "expiresInS: 86400 (24 h), 604800 (7 days), 2592000 (30 days) or null (no expiry)", code: "invalid" };
}

export type Grant = {
  who: Who;
  role: Role;
  /** The entry as it stands, null for someone new. */
  existing: Entry | null;
  /** Someone new outside the company's domains: a password is drawn for them. */
  password: boolean;
  /** A role above `visitor` given or raised, which asks for the granter's unlock. */
  raises: boolean;
};

const ROLE_WORDS: Readonly<Record<Role, string>> = { visitor: "Can open", viewer: "Viewer", developer: "Developer", admin: "Admin" };

/** The role as the people with access read it. */
export function roleWord(role: Role): string {
  return ROLE_WORDS[role];
}

/**
 * May this granter give `who` this role on this project? The entry as it
 * stands is read from the registry; the answer says whether a password is to
 * be drawn and whether the change asks for an unlock.
 */
export function judgeGrant(registry: Registry, slug: string, whoValue: unknown, role: Role, granter: Granter, signIn: SignInSettings): Grant | Refusal {
  const who = readWho(whoValue);
  if ("refusal" in who) return who;
  const existing = findEntry(registry, slug, who.who);
  const ceiling = grantCeiling(granter);
  if (ceiling === null) return { refusal: `${granterName(granter)} does not manage the people with access to ${slug}: that takes its Admin`, code: "out-of-scope" };

  if (who.kind === "domain") {
    if (role !== "visitor") return { refusal: `${who.who}: a domain can only open the site (Can open); give people roles one by one`, code: "invalid" };
    if (!signIn.configured) {
      return { refusal: `${who.who}: signing in with a company account is not set up on this machine, so nobody at a domain could open the site; add people by email, who get password access`, code: "invalid" };
    }
    // Whoever is not the owner did not choose the company's domains: the owner
    // did, in OIDC_ALLOWED_DOMAINS. A domain already there is not widened by
    // keeping it.
    if (granter.kind !== "owner" && existing === null && !signIn.allowedDomains.includes(who.domain)) {
      return {
        refusal:
          signIn.allowedDomains.length === 0
            ? `${who.who}: the company's domains are not listed on this machine (OIDC_ALLOWED_DOMAINS), so only the owner gives a whole domain access; add people by email`
            : `${who.who}: only the owner gives a domain outside the company's (${signIn.allowedDomains.join(", ")}) access`,
        code: "out-of-scope",
      };
    }
    return { who, role, existing, password: false, raises: false };
  }

  if (rank(role) > rank(ceiling)) {
    return {
      refusal:
        granter.kind === "token"
          ? `a token gives people Can open alone: ${roleWord(role)} is given from the dashboard, or by the owner over SSH`
          : `${granterName(granter)} may give at most ${roleWord(ceiling)} on ${slug}`,
      code: "out-of-scope",
    };
  }
  // Lowering or keeping someone the granter could not have given is no business of theirs either.
  if (existing !== null && rank(existing.role) > rank(ceiling)) {
    return { refusal: `${who.who} holds ${roleWord(existing.role)} on ${slug}: only someone who may give that role changes it`, code: "out-of-scope" };
  }

  if (existing?.password !== undefined) {
    if (role !== "visitor") return { refusal: `${who.who} has password access, which opens the site and nothing more: remove it first to give them a role`, code: "out-of-scope" };
    return { who, role, existing, password: false, raises: false };
  }
  if (!signsInWithAccount(who.email, signIn)) {
    const why = !signIn.configured
      ? "signing in with a company account is not set up on this machine"
      : `${domainOf(who.email)} is not among the company's domains (${signIn.allowedDomains.join(", ")})`;
    if (atLeast(role, "viewer")) {
      return { refusal: `${who.who} can only be given Can open, with password access: ${why}`, code: "invalid" };
    }
    // Someone already on the list keeps the way in they had; someone new gets a password.
    if (existing === null && granter.kind === "token") {
      return { refusal: `${who.who} would get password access (${why}), which is given from the dashboard or by the owner over SSH, never with a token`, code: "out-of-scope" };
    }
    if (existing === null) return { who, role, existing, password: true, raises: false };
  }
  return { who, role, existing, password: false, raises: atLeast(role, "viewer") && (existing === null || rank(role) > rank(existing.role)) };
}

/**
 * May this granter remove this entry? Anyone who manages the project removes
 * anyone they could have given that role; a token, `visitor` entries.
 */
export function judgeRemoval(registry: Registry, slug: string, whoValue: unknown, granter: Granter): { entry: Entry } | Refusal {
  const ceiling = grantCeiling(granter);
  if (ceiling === null) return { refusal: `${granterName(granter)} does not manage the people with access to ${slug}: that takes its Admin`, code: "out-of-scope" };
  // A name carried over from before the registry is matched as it stands.
  const read = readWho(whoValue);
  const key = "refusal" in read ? (typeof whoValue === "string" ? whoValue.trim() : "") : read.who;
  const entry = key === "" ? null : findEntry(registry, slug, key);
  if (entry === null) return { refusal: `${key === "" ? "who" : key} has no access to ${slug}`, code: "not-found" };
  if (rank(entry.role) > rank(ceiling)) {
    return {
      refusal: granter.kind === "token" ? `${entry.who} holds ${roleWord(entry.role)} on ${slug}: a token removes Can open entries alone` : `${entry.who} holds ${roleWord(entry.role)} on ${slug}: only someone who may give that role removes it`,
      code: "out-of-scope",
    };
  }
  return { entry };
}
