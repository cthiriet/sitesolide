/**
 * Who is signed in, as the page needs to know it: the owner, or a person
 * signed in with their company account, their role on each project, the way
 * their unlock starts and what a sign-in or an unlock that came back without
 * a session means. Pure.
 *
 * The rules of who may do what are not here: the steward judges every write
 * against the access registry, and the page shows its refusal. The page only
 * offers what a role opens, so as not to show a button that ends in a
 * refusal.
 */
import type { IdentityView, Role } from "./types"

export type Person = Extract<IdentityView, { kind: "person" }>

export function isPerson(identity: IdentityView | null): identity is Person {
  return identity !== null && identity.kind === "person"
}

/** The person's role on a project, null for none or for the owner. */
export function roleOn(identity: IdentityView | null, slug: string): Role | null {
  if (!isPerson(identity)) return null
  return Object.hasOwn(identity.roles, slug) ? identity.roles[slug]! : null
}

/** May this person restart this project's service? What the page offers; the steward decides. */
export function mayRestart(identity: IdentityView | null, slug: string): boolean {
  const role = roleOn(identity, slug)
  return role === "developer" || role === "admin"
}

/** An Admin of this project: the one person who reads its secrets, changes its access and restores its backups. */
export function isAdminOf(identity: IdentityView | null, slug: string): boolean {
  return roleOn(identity, slug) === "admin"
}

/**
 * Where a person's unlock begins: a forced sign-in at the provider, coming
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
      return "You're a Viewer on every project: there's nothing to unlock."
    case "outdated":
      return "This server's steward can't unlock for you yet. Ask the owner to run sitesolide upgrade."
    case "expired":
      return "This unlock took too long, or was finished in another browser. Unlock again."
    default:
      return "Unlocking isn't available right now. Try again in a moment."
  }
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
      return "This account has no role on any project here. Ask the owner, or an Admin of the project, to add you."
    case "domain-not-allowed":
      return "This account's domain isn't allowed to sign in here."
    case "expired":
      return "This sign-in expired or was opened in another browser. Sign in again."
    case "busy":
      return "Too many sign-ins right now. Try again in a minute."
    case "unavailable":
      return "Signing in with a company account isn't available right now. Try again later."
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
