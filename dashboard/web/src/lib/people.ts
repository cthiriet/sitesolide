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
import type { AccessRole, PersonView, TokenView } from "./types"

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

/** Every password access that has ended, across projects: what "Remove expired" takes off. */
export function expiredAccesses(people: readonly Pick<PersonView, "who" | "passwords">[], now: number): { slug: string; who: string }[] {
  return people
    .flatMap((person) => person.passwords.filter((one) => one.expired || (one.expiresAt !== null && one.expiresAt <= now)).map((one) => ({ slug: one.slug, who: person.who })))
    .sort((a, b) => a.slug.localeCompare(b.slug, "en") || a.who.localeCompare(b.who, "en"))
}

/**
 * The tokens taken off with someone removed from every project: every live
 * token of theirs, whoever made it, said with who did, in one sentence.
 * Null when they have none.
 */
export function revokedTokensLine(tokens: readonly Pick<TokenView, "label" | "member" | "by" | "revokedAt" | "expiresAt">[], email: string, now: number): string | null {
  const theirs = tokens.filter((token) => token.member === email && token.revokedAt === null && (token.expiresAt === null || now < token.expiresAt))
  if (theirs.length === 0) return null
  const named = theirs.map((token) => `${token.label} (made by ${token.by === "owner" ? "you" : "them"})`)
  return `Also revokes ${theirs.length === 1 ? "1 token" : `${theirs.length} tokens`}: ${named.join(", ")}.`
}

/**
 * What removing someone from every project takes, said before it is done:
 * the create right only when they held it, the dashboard only when they
 * signed in to it, a role above Can open or the create right.
 */
export function removalSentence(person: Pick<PersonView, "roles" | "create" | "passwords"> | null): string {
  if (person === null) return ""
  const signsIn = person.create || Object.values(person.roles).some((role) => role !== "visitor")
  const parts = [`They lose every role${person.passwords.length > 0 ? " and password access" : ""} at their next request`]
  if (person.create) parts.push("may no longer create projects")
  if (signsIn) parts.push("are signed out of the dashboard")
  return parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}.`
}
