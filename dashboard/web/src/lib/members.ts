/**
 * What the members' parts of the page decide: the words of a role, the line to
 * send an invited person, the form's own checks, a refusal said in words, and
 * what a sign-in that came back without a session means. Pure.
 *
 * The rules of who may do what are not here: the steward judges an invitation
 * and every member's write, and the page shows its refusal. The form only
 * refuses what it can see is empty or malformed.
 */
import type { IdentityView, Role, Roles } from "./types"

export const ROLE_CHOICES: readonly { role: Role; label: string; help: string }[] = [
  { role: "viewer", label: "Viewer", help: "Sees the project: its state, its audience, its activity." },
  { role: "developer", label: "Developer", help: "Also restarts its service, and sets, replaces and removes its secrets without ever reading one back." },
  {
    role: "admin",
    label: "Project admin",
    help: "Everything of the project: reads its secrets, turns its portal on or off, shares it, gives guest access, restores its backups, and gives people a role on it.",
  },
]

export function roleLabel(role: Role): string {
  return ROLE_CHOICES.find((choice) => choice.role === role)?.label ?? role
}

/** May this person restart this project's service? What the page offers; the steward decides. */
export function mayRestart(identity: IdentityView | null, slug: string): boolean {
  if (identity === null || identity.kind !== "member") return false
  const role = Object.hasOwn(identity.roles, slug) ? identity.roles[slug] : undefined
  return role === "developer" || role === "admin"
}

export function isMember(identity: IdentityView | null): identity is Extract<IdentityView, { kind: "member" }> {
  return identity !== null && identity.kind === "member"
}

/** The member's role on a project, null for none or for the super admin. */
export function roleOn(identity: IdentityView | null, slug: string): Role | null {
  if (!isMember(identity)) return null
  return Object.hasOwn(identity.roles, slug) ? identity.roles[slug]! : null
}

/** A Project admin of this project: the one member who reads its secrets, its door, sharing, guests, backups and members. */
export function isProjectAdmin(identity: IdentityView | null, slug: string): boolean {
  return roleOn(identity, slug) === "admin"
}

/**
 * Where a member's unlock begins: a forced sign-in at the provider, coming
 * back to this page. A previous refusal's note is left off the way back.
 */
export function reauthUrl(path: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete("unlock")
  const query = params.toString()
  return `/api/sso/begin?${new URLSearchParams({ reauth: "1", return: `${path}${query === "" ? "" : `?${query}`}` })}`
}

/**
 * What an unlock that came back without unlocking means, from the reason the
 * dashboard put in the address (`?unlock=<reason>`).
 */
export function unlockFailure(reason: string | null): string | null {
  switch (reason) {
    case null:
    case "":
      return null
    case "refused":
      return "The unlock didn't go through: your identity provider didn't confirm that you just signed in again. Try once more."
    case "another-account":
      return "You signed in again with another account than this session's. Unlock with your own account."
    case "busy":
      return "Too many unlock attempts. Wait a minute, then try again."
    case "nothing-to-unlock":
      return "You're a viewer on every project: there's nothing to unlock."
    case "outdated":
      return "This server's steward doesn't know members' unlocks yet. Ask the super admin to run sitesolide upgrade."
    case "expired":
      return "This unlock took too long, or was finished in another browser. Unlock again."
    default:
      return "Unlocking isn't available right now. Try again in a moment."
  }
}

/** `blog: Developer, shop: Viewer`. */
export function rolesSummary(roles: Roles): string {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b, "en"))
  return entries.length === 0 ? "No project" : entries.map(([slug, role]) => `${slug}: ${roleLabel(role)}`).join(", ")
}

/**
 * The line to send the person invited: where to go, and with what. Nothing in
 * it opens the dashboard; they still sign in, and get in only if they are a
 * member.
 */
export function invitationLine(dashboardUrl: string, providerName: string | null): string {
  const account = providerName === null || providerName === "your work account" ? "your work account" : `your ${providerName} work account`
  return `Open ${dashboardUrl} and sign in with ${account}.`
}

export type MemberField = "email" | "roles"
export type MemberErrors = Partial<Record<MemberField, string>>

/** The rows of the form: a project and its role, a project once. */
export type RoleRow = { slug: string; role: Role }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * What the form can see is wrong before sending. The steward judges the rest,
 * the allowed domains included. `create`: the right to create projects, which
 * is enough on its own, a member who will create their projects holding none
 * yet.
 */
export function validateMemberForm(email: string, rows: readonly RoleRow[], allowedDomains: readonly string[], create = false): MemberErrors {
  const errors: MemberErrors = {}
  const address = email.trim().toLowerCase()
  if (!EMAIL.test(address)) errors.email = "Enter the person's work email."
  else if (allowedDomains.length > 0 && !allowedDomains.includes(address.slice(address.lastIndexOf("@") + 1))) {
    errors.email = `The portal admits only ${allowedDomains.join(", ")}: this person couldn't sign in.`
  }
  const slugs = rows.map((row) => row.slug).filter((slug) => slug !== "")
  if (slugs.length === 0 && !create) errors.roles = "Give them a role on one project at least, or the right to create projects."
  else if (new Set(slugs).size !== slugs.length) errors.roles = "A project appears twice."
  return errors
}

export function rolesFromRows(rows: readonly RoleRow[]): Roles {
  const roles: Roles = {}
  for (const row of rows) if (row.slug !== "") roles[row.slug] = row.role
  return roles
}

export function rowsFromRoles(roles: Roles): RoleRow[] {
  return Object.entries(roles)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([slug, role]) => ({ slug, role }))
}

/** A refusal of the steward's or the service's, in words, and the field it concerns when there is one. */
export function memberRefusal(status: number, body: { error?: string; message?: string } | null): { field: MemberField | null; message: string } {
  if (status === 0) return { field: null, message: "Can't reach the dashboard. Check your connection." }
  const message = body?.message ?? `Refused (${status}).`
  if (body?.error === "invalid") {
    if (/^email|admits only|cannot sign in/.test(message)) return { field: "email", message }
    if (message.startsWith("roles") || message.includes("project")) return { field: "roles", message }
  }
  return { field: null, message }
}

/**
 * What a sign-in with the provider that came back without a session means,
 * from the reason the dashboard put in the address (`/?signin=<reason>`).
 */
export function signInFailure(reason: string | null): string | null {
  switch (reason) {
    case null:
    case "":
      return null
    case "not-a-member":
      return "This account isn't a member of this dashboard. Ask its owner to invite you."
    case "domain-not-allowed":
      return "This account's domain isn't allowed to sign in here."
    case "expired":
      return "This sign-in expired or was opened in another browser. Sign in again."
    case "busy":
      return "Too many sign-ins right now. Try again in a minute."
    case "unavailable":
      return "Signing in with a work account isn't available right now. Try again later."
    case "invalid":
      return "The sign-in couldn't be verified. Sign in again."
    default:
      return "The sign-in didn't go through. Sign in again."
  }
}

/** Where the provider's sign-in starts, coming back to this page. */
export function signInUrl(returnTo: string, chooseAccount = false): string {
  const query = new URLSearchParams({ return: returnTo })
  if (chooseAccount) query.set("account", "choose")
  return `/api/sso/begin?${query}`
}
