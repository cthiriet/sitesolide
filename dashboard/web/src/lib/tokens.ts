/**
 * What the Tokens page decides: a token's state, its scope said in words, the
 * form's own checks, the login command, a deployment's tone and an audit line.
 * Pure: the clock arrives as a parameter.
 *
 * The rules of who may deploy what are not here: the steward judges a token's
 * request and the page shows its refusal. The form only refuses what it can
 * see is empty or malformed, so that the owner does not wait for a round trip
 * to learn a field is missing.
 */
import { duration } from "./format"
import type { Tone } from "./tones"
import type { AuditEntry, DeploymentState, Role, Roles, Scope, TokenView } from "./types"

const DAY = 24 * 60 * 60 * 1000

/** Within this, an expiry is worth a look. */
export const EXPIRY_WARNING_MS = 7 * DAY

/** The expiry offered by the form. */
export const EXPIRY_CHOICES: readonly { label: string; days: number | null }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "No expiry", days: null },
]

export const DEFAULT_EXPIRY_DAYS = 90

export function expiryFrom(days: number | null, now: number): number | null {
  return days === null ? null : now + days * DAY
}

/** A token's state, as one word and its tone. */
export function tokenStatus(token: Pick<TokenView, "revokedAt" | "expiresAt">, now: number): { label: string; tone: Tone } {
  if (token.revokedAt !== null) return { label: "Revoked", tone: "neutral" }
  if (token.expiresAt !== null && now >= token.expiresAt) return { label: "Expired", tone: "neutral" }
  if (token.expiresAt !== null && token.expiresAt - now <= EXPIRY_WARNING_MS) return { label: `Expires in ${duration(token.expiresAt - now)}`, tone: "attention" }
  return { label: "Active", tone: "ok" }
}

/** Is the token still able to deploy? */
export function isLive(token: Pick<TokenView, "revokedAt" | "expiresAt">, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || now < token.expiresAt)
}

/**
 * What the token may do beyond deploying its projects, in words, only what
 * is on: nothing is said of what is off, which is every token's default.
 */
export function scopeSummary(scope: Scope): string[] {
  const parts: string[] = []
  if (scope.create) parts.push("Can create projects")
  if (scope.public) parts.push("Can deploy public sites")
  if (scope.domain) parts.push("Can declare a domain")
  if (scope.outbound) parts.push("Can use outbound network")
  return parts
}

/** The projects a token reaches: those it created, then those granted, each once. */
export function reachedProjects(token: Pick<TokenView, "owned" | "scope">): { slug: string; how: "created" | "granted" }[] {
  const created = token.owned.map((slug) => ({ slug, how: "created" as const }))
  const granted = token.scope.slugs.filter((slug) => !token.owned.includes(slug)).map((slug) => ({ slug, how: "granted" as const }))
  return [...created, ...granted]
}

/** The slugs typed in the form: commas, spaces or lines between them, each once, in order. */
export function parseSlugs(text: string): string[] {
  const seen: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    const slug = part.trim().toLowerCase()
    if (slug !== "" && !seen.includes(slug)) seen.push(slug)
  }
  return seen
}

export type TokenField = "label" | "slugs"
export type TokenErrors = Partial<Record<TokenField, string>>

const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** What the owner's form for a token of their own can see is wrong before sending. The steward judges the rest. */
export function validateTokenForm(fields: { label: string; slugs: string[] }, knownSlugs: readonly string[]): TokenErrors {
  const errors: TokenErrors = {}
  if (fields.label.trim() === "") errors.label = "Name the agent or the workstation this token is for."
  const bad = fields.slugs.find((slug) => !SLUG.test(slug) || slug.length > 63)
  if (bad !== undefined) errors.slugs = `${bad} is not a slug: lowercase letters, digits and dashes.`
  else {
    const unknown = fields.slugs.filter((slug) => !knownSlugs.includes(slug))
    if (unknown.length > 0) errors.slugs = `Not on this machine: ${unknown.join(", ")}. A new project needs "May create projects" instead.`
  }
  return errors
}

export function firstTokenField(errors: TokenErrors): TokenField | null {
  for (const field of ["label", "slugs"] as const) if (errors[field] !== undefined) return field
  return null
}

/** Who a token may be made for by the owner: the people who sign in, a role above Can open or the right to create projects. */
export function tokenHolders(people: readonly { who: string; roles: Readonly<Record<string, Role | "visitor">>; create: boolean }[]): { email: string; roles: Roles; create: boolean }[] {
  return people
    .map((person) => ({
      email: person.who,
      roles: Object.fromEntries(Object.entries(person.roles).filter((entry): entry is [string, Role] => entry[1] !== "visitor")) as Roles,
      create: person.create,
    }))
    .filter((person) => person.create || Object.keys(person.roles).length > 0)
    .sort((a, b) => a.email.localeCompare(b.email))
}

/**
 * Who made a token, and for whom, as a row says it: "Made by you", "Made by
 * you for alice@example.com", "Made by alice@example.com". `viewer`: who
 * reads the row, the owner or the person it belongs to.
 */
export function madeByLine(token: Pick<TokenView, "member" | "by" | "email">, viewer: "owner" | "person"): string {
  if (token.member === null) return token.email === "owner" ? "Made by you" : `Made by you for ${token.email}`
  if (viewer === "person") return token.by === "owner" ? "Made by the owner for you" : "Made by you"
  return token.by === "owner" ? `Made by you for ${token.member}` : `Made by ${token.member}`
}

export type Reach = { slug: string; text: string; paused: boolean }

/**
 * Where a person's token deploys now: each project it was given or created,
 * with that person's role there today. Below Developer, it is paused there
 * until the role comes back: "calendar (Admin)", "cms (paused: Viewer now)".
 * The owner's own token says which projects it created.
 */
export function liveReach(token: Pick<TokenView, "owned" | "scope" | "member">, roles: Readonly<Record<string, Role | "visitor">> | null): Reach[] {
  const projects = reachedProjects(token)
  if (token.member === null || roles === null) {
    return projects.map(({ slug, how }) => ({ slug, text: how === "created" ? `${slug} (created)` : slug, paused: false }))
  }
  return projects.map(({ slug }) => {
    const role = Object.hasOwn(roles, slug) ? roles[slug]! : null
    if (role === "developer" || role === "admin") return { slug, text: `${slug} (${ROLE_WORDS[role]})`, paused: false }
    return { slug, text: `${slug} (paused: ${role === null ? "no role" : ROLE_WORDS[role]} now)`, paused: true }
  })
}

const ROLE_WORDS: Readonly<Record<Role | "visitor", string>> = { visitor: "Can open", viewer: "Viewer", developer: "Developer", admin: "Admin" }

/** The command the holder runs, without the token: typed at its prompt, it never lands in a shell history. */
export function loginCommand(origin: string): string {
  return `sitesolide login --url ${origin}`
}

/** What the holder receives, ready to paste in a message: the address, the command, the token. */
export function messageText(origin: string, secret: string): string {
  return [`Dashboard: ${origin}`, `Sign in: ${loginCommand(origin)}`, `Token (paste it at the prompt): ${secret}`].join("\n")
}

export function deploymentTone(state: DeploymentState): Tone {
  switch (state) {
    case "succeeded":
      return "ok"
    case "failed":
      return "error"
    case "running":
    case "awaiting-bundle":
      return "attention"
    default:
      return "neutral"
  }
}

export function deploymentLabel(state: DeploymentState): string {
  return { "awaiting-bundle": "Uploading", running: "Running", succeeded: "Deployed", failed: "Failed", expired: "Abandoned" }[state]
}

/** An audit line in words: who, did what, on what. Never a value, the audit carries none. */
export function auditLine(entry: Pick<AuditEntry, "actor" | "action" | "target" | "detail">): string {
  const detail = entry.detail ?? {}
  const email = typeof detail.email === "string" ? detail.email : null
  const who = entry.actor === "owner" ? "You" : (email ?? entry.actor)
  const label = typeof detail.label === "string" ? detail.label : null
  switch (entry.action) {
    case "token.create":
      return `${who} created a token for ${email ?? "someone"}${label === null ? "" : ` (${label})`}`
    case "token.revoke":
      return `${who} revoked the token of ${email ?? "someone"}${label === null ? "" : ` (${label})`}`
    case "deploy.start":
      return `${who} started a deployment of ${entry.target ?? "a project"}${detail.creating === true ? ", a new project" : ""}`
    case "deploy.success":
      return `${who} deployed ${entry.target ?? "a project"}`
    case "deploy.failure":
      return `${who} failed to deploy ${entry.target ?? "a project"}${typeof detail.error === "string" ? ` (${detail.error})` : ""}`
    default:
      return `${who}: ${entry.action}${entry.target === null ? "" : ` ${entry.target}`}`
  }
}

/** The refusal of a creation, under the field it concerns when the steward's message names one. */
export function tokenRefusal(status: number, body: { error?: string; message?: string } | null): { field: TokenField | null; message: string } {
  const message = body?.message ?? (status === 0 ? "Can't reach the dashboard." : `Refused (${status}).`)
  if (status === 400) {
    if (message.startsWith("label")) return { field: "label", message: "One line of text, 64 characters at most." }
    if (message.startsWith("scope.slugs")) return { field: "slugs", message: message.replace(/^scope\.slugs: /, "") }
  }
  // A person's token above their roles: the steward's words, each reason without its field's prefix.
  if (status === 403 && /^scope\.[a-z]+: /.test(message)) {
    return { field: message.startsWith("scope.slugs") ? "slugs" : null, message: message.replace(/scope\.[a-z]+: /g, "") }
  }
  return { field: null, message }
}

// --- a person's own tokens ----------------------------------------------------------

/**
 * The projects a person's token may deploy: those where they are a Developer
 * or an Admin, sorted. The steward judges again; the page offers only
 * these.
 */
export function mintableProjects(roles: Roles): { slug: string; role: Exclude<Role, "viewer"> }[] {
  return Object.entries(roles)
    .filter((entry): entry is [string, Exclude<Role, "viewer">] => entry[1] === "developer" || entry[1] === "admin")
    .map(([slug, role]) => ({ slug, role }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * May a person's token carry the options, public sites, a domain, outbound
 * network: only when they are Admin of every project chosen; with
 * none chosen, only for a token that creates, whose projects make them
 * their Admin.
 */
export function optionsAllowed(roles: Roles, slugs: readonly string[], create: boolean): boolean {
  if (slugs.length === 0) return create
  return slugs.every((slug) => Object.hasOwn(roles, slug) && roles[slug] === "admin")
}

/** What a person's form can see is wrong before sending: a name, and something to deploy. */
export function validatePersonTokenForm(fields: { label: string; slugs: readonly string[]; create: boolean }): TokenErrors {
  const errors: TokenErrors = {}
  if (fields.label.trim() === "") errors.label = "Name the laptop, the workstation or the agent this token is for."
  if (fields.slugs.length === 0 && !fields.create) errors.slugs = "Choose at least one project, or creating projects."
  return errors
}
