/**
 * What the People page decides: how each person reads across projects, what
 * may be done with them, and the domains that have access. Pure.
 *
 * The steward judges every change (dashboard/src/access/rules.ts): giving
 * the right to create projects needs the unlock and a company account,
 * taking it away or taking someone off every project never waits. The page
 * offers only what the steward will accept.
 */
import { cleanEmail } from "../../../borrowed/sharing"
import { passwordExpiry, roleLabel, signsInWithAccount, type Expiry, type SignIn } from "./access"
import type { AccessRole, PersonView } from "./types"

export type ProjectRole = { slug: string; role: AccessRole; label: string; password: Expiry | null }

/** A person's roles, one per project, sorted by project; a password access says its expiry. */
export function projectRoles(person: Pick<PersonView, "roles" | "passwords">, now: number): ProjectRole[] {
  return Object.entries(person.roles)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([slug, role]) => {
      const password = person.passwords.find((one) => one.slug === slug) ?? null
      return { slug, role, label: password === null ? roleLabel(role) : "Password access", password: password === null ? null : passwordExpiry(password, now) }
    })
}

/** Can the steward take this person off everywhere: they have a role somewhere, or the create right. */
export function mayRemove(person: Pick<PersonView, "roles" | "create">): boolean {
  return person.create || Object.keys(person.roles).length > 0
}

/**
 * May this person be given the right to create projects: only someone who
 * signs in with their company account, since it is in the dashboard and with
 * a token of theirs that they create.
 */
export function mayGetCreate(who: string, signIn: SignIn): boolean {
  const email = cleanEmail(who)
  return email !== null && signsInWithAccount(email, signIn)
}

/** Why the create right is not offered to someone, when it is not. */
export function createRefusal(who: string, signIn: SignIn): string | null {
  if (mayGetCreate(who, signIn)) return null
  if (!signIn.configured) return "Company sign-in isn't set up, so only the owner creates projects."
  return "Only someone with a company account can create projects."
}

/** The domains that have access, each with the projects it opens, sorted. */
export function domainGroups(domains: readonly { slug: string; domain: string }[]): { domain: string; slugs: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const { slug, domain } of domains) groups.set(domain, [...(groups.get(domain) ?? []), slug])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([domain, slugs]) => ({ domain, slugs: slugs.sort() }))
}

/** What the field that gives the create right to someone new says of what is typed, or null when it reads. */
export function createFieldError(text: string, signIn: SignIn): string | null {
  const email = cleanEmail(text)
  if (email === null) return "Enter their company email, like name@company.com."
  return createRefusal(email, signIn)
}
