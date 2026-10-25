/**
 * What the People page decides: one list of everyone and every domain with
 * access, how each reads across projects, what may be done with them. Pure.
 *
 * The steward judges every change (dashboard/src/access/rules.ts): giving
 * the right to create projects needs the unlock and a company account,
 * taking it away or taking someone off every project never waits. The page
 * offers only what the steward will accept.
 */
import { cleanEmail } from "../../../borrowed/sharing"
import { isExpired, passwordExpiry, roleLabel, signsInWithAccount, type Expiry, type SignIn } from "./access"
import { duration } from "./format"
import { normalize } from "./search"
import { isLive } from "./tokens"
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
    .flatMap((person) => person.passwords.filter((one) => isExpired({ password: one }, now)).map((one) => ({ slug: one.slug, who: person.who })))
    .sort((a, b) => a.slug.localeCompare(b.slug, "en") || a.who.localeCompare(b.who, "en"))
}

/**
 * The tokens taken off with someone removed from every project: every live
 * token of theirs, whoever made it, said with who did, in one sentence.
 * Null when they have none.
 */
export function revokedTokensLine(tokens: readonly Pick<TokenView, "label" | "member" | "by" | "revokedAt" | "expiresAt">[], email: string, now: number): string | null {
  const theirs = tokens.filter((token) => token.member === email && isLive(token, now))
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

// --- One list: people, password access and domains ------------------------------------

/**
 * What a row of People is: someone who signs in with their company account,
 * someone who opens sites with a password the owner gave them, or everyone
 * at a domain.
 */
export type EntryKind = "account" | "password" | "domain"

/** The order of the Type facet. */
export const ENTRY_KINDS: readonly EntryKind[] = ["account", "password", "domain"]

/** Each kind in words: `label` for one row, its tooltip and its sheet; `facet` for the set. */
export const ENTRY_WORDS: Readonly<Record<EntryKind, { label: string; facet: string; description: string }>> = {
  account: { label: "Company account", facet: "Company accounts", description: "Signs in with their company account." },
  password: { label: "Password access", facet: "Password access", description: "Opens sites with a password you gave them." },
  domain: { label: "Domain", facet: "Domains", description: "Everyone with a company account at the domain." },
}

export type PeopleEntry =
  | { key: string; kind: "account" | "password"; who: string; person: PersonView }
  | { key: string; kind: "domain"; who: string; slugs: string[] }

/**
 * A person's kind: password access when every project they are on is
 * through a password, a company account otherwise, someone with no project
 * included (the create right, an admin email).
 */
export function personKind(person: Pick<PersonView, "roles" | "passwords">): "account" | "password" {
  const slugs = Object.keys(person.roles)
  if (person.passwords.length === 0 || slugs.length === 0) return "account"
  return slugs.every((slug) => person.passwords.some((one) => one.slug === slug)) ? "password" : "account"
}

/**
 * Everyone with access to a project, and every domain, in one list: people
 * by email or name, ignoring case, then the domains. Keyed by who, a domain
 * by its `@`, which is how its sheet is addressed.
 */
export function peopleEntries(people: readonly PersonView[], domains: readonly { slug: string; domain: string }[]): PeopleEntry[] {
  const persons = [...people]
    .sort((a, b) => a.who.localeCompare(b.who, "en", { sensitivity: "base" }))
    .map((person): PeopleEntry => ({ key: person.who, kind: personKind(person), who: person.who, person }))
  const groups = domainGroups(domains).map(({ domain, slugs }): PeopleEntry => ({ key: domain, kind: "domain", who: domain, slugs }))
  return [...persons, ...groups]
}

/** Does an entry answer the list's search: who, or a project it opens. */
export function entryMatches(entry: PeopleEntry, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter((word) => word !== "")
  const slugs = entry.kind === "domain" ? entry.slugs : Object.keys(entry.person.roles)
  const haystack = normalize([entry.who, ...slugs].join(" "))
  return words.every((word) => haystack.includes(word))
}

/** A row's project, as its Projects cell and its sheet say it: the slug, and the role or "Password access". */
export type EntryProject = { slug: string; role: string; password: boolean }

/** The projects of a row, by project: a domain's are all Can open. */
export function entryProjects(entry: PeopleEntry, now: number): EntryProject[] {
  if (entry.kind === "domain") return entry.slugs.map((slug) => ({ slug, role: roleLabel("visitor"), password: false }))
  return projectRoles(entry.person, now).map(({ slug, label, password }) => ({ slug, role: label, password: password !== null }))
}

/** Within this, a password access's end is worth a look. */
const ENDS_SOON_MS = 24 * 3600_000

/**
 * The Expires cell, for password access alone: the soonest end of the
 * accesses still open, "in 14h" in attention under a day, "in 6d"; "No
 * expiry" while one never ends; "Expired" once all have. Null for
 * everyone else.
 */
export function accessExpiry(person: Pick<PersonView, "passwords">, now: number): { text: string; tone: "muted" | "attention" | "plain" } | null {
  if (person.passwords.length === 0) return null
  const open = person.passwords.filter((one) => !isExpired({ password: one }, now))
  if (open.length === 0) return { text: "Expired", tone: "muted" }
  const ends = open.map((one) => one.expiresAt).filter((at): at is number => at !== null)
  if (ends.length === 0) return { text: "No expiry", tone: "muted" }
  const left = Math.min(...ends) - now
  return { text: `in ${duration(left)}`, tone: left < ENDS_SOON_MS ? "attention" : "plain" }
}
