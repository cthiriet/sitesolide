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
 * What the token may do, in a few words: general access first, which is what
 * the owner worries about. A person's token deploys its projects with the
 * general access they have, public for one that is, and makes none public
 * without the option.
 */
export function scopeSummary(scope: Scope, personal = false): string[] {
  const parts = [scope.public ? "Public sites allowed" : personal ? "Makes no site public" : "Restricted sites only"]
  if (scope.create) parts.push("Creates projects")
  if (scope.outbound) parts.push("Outbound network")
  if (scope.domain) parts.push("Own domains")
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

export type TokenField = "label" | "email" | "slugs"
export type TokenErrors = Partial<Record<TokenField, string>>

const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** What the form can see is wrong before sending. The steward judges the rest. */
export function validateTokenForm(fields: { label: string; email: string; slugs: string[] }, knownSlugs: readonly string[]): TokenErrors {
  const errors: TokenErrors = {}
  if (fields.label.trim() === "") errors.label = "Name the person or the agent this token is for."
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) errors.email = "Enter the address of the person who will hold it."
  const bad = fields.slugs.find((slug) => !SLUG.test(slug) || slug.length > 63)
  if (bad !== undefined) errors.slugs = `${bad} is not a slug: lowercase letters, digits and dashes.`
  else {
    const unknown = fields.slugs.filter((slug) => !knownSlugs.includes(slug))
    if (unknown.length > 0) errors.slugs = `Not on this machine: ${unknown.join(", ")}. A new project needs "May create projects" instead.`
  }
  return errors
}

export function firstTokenField(errors: TokenErrors): TokenField | null {
  for (const field of ["label", "email", "slugs"] as const) if (errors[field] !== undefined) return field
  return null
}

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
    if (message.startsWith("email")) return { field: "email", message: "Enter the address of the person who will hold it." }
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
