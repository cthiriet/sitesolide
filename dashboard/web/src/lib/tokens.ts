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
import { isPlatform } from "./access"
import { duration } from "./format"
import type { Tone } from "./tones"
import type { AuditEntry, DeploymentState, Role, Roles, Scope, Site, TokenView } from "./types"

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

export type ScopeLine = { text: string; paused: boolean }

/**
 * What a token may do beyond deploying, as its row says it, what is on alone:
 * a person's said paused, greyed, while they no longer hold it, as the
 * steward narrows it at every use (src/people/tokens.ts, `narrowIdentity`).
 * The create right while they hold it; each option while they are Admin of
 * every project the token still deploys: "Can create projects (paused: no
 * longer allowed)", "Can use outbound network (paused: not Admin of cms
 * now)". `rights` null: the owner's own, or rights not known.
 */
export function scopeLines(token: Pick<TokenView, "owned" | "scope" | "member">, rights: { roles: Readonly<Record<string, Role | "visitor">>; create: boolean } | null): ScopeLine[] {
  const words = scopeSummary(token.scope)
  if (token.member === null || rights === null) return words.map((text) => ({ text, paused: false }))
  const roleOf = (slug: string) => (Object.hasOwn(rights.roles, slug) ? rights.roles[slug]! : null)
  const deploys = (slug: string) => roleOf(slug) === "developer" || roleOf(slug) === "admin"
  const reached = [...new Set([...token.scope.slugs, ...token.owned])].filter(deploys).sort()
  const create = token.scope.create && rights.create
  const notAdmin = reached.filter((slug) => roleOf(slug) !== "admin")
  const optionPause = reached.length === 0 && !create ? "paused: no project to deploy now" : notAdmin.length > 0 ? `paused: not Admin of ${notAdmin.join(", ")} now` : null
  return words.map((text) => {
    const pause = text === "Can create projects" ? (rights.create ? null : "paused: no longer allowed") : optionPause
    return pause === null ? { text, paused: false } : { text: `${text} (${pause})`, paused: true }
  })
}

/** The projects a token reaches: those it created, then those granted, each once. */
export function reachedProjects(token: Pick<TokenView, "owned" | "scope">): { slug: string; how: "created" | "granted" }[] {
  const created = token.owned.map((slug) => ({ slug, how: "created" as const }))
  const granted = token.scope.slugs.filter((slug) => !token.owned.includes(slug)).map((slug) => ({ slug, how: "granted" as const }))
  return [...created, ...granted]
}

export type TokenField = "label" | "slugs"
export type TokenErrors = Partial<Record<TokenField, string>>

/** What the form can see is wrong before sending: a name, and something to deploy. The steward judges the rest. */
export function validateTokenForm(fields: { label: string; slugs: readonly string[]; create: boolean }): TokenErrors {
  const errors: TokenErrors = {}
  if (fields.label.trim() === "") errors.label = "Name the laptop, the workstation or the agent this token is for."
  if (fields.slugs.length === 0 && !fields.create) errors.slugs = "Choose at least one project, or New projects."
  return errors
}

/**
 * A project the dialog offers, and what deploying it takes from a token, read
 * from the server's snapshot: `open`, its general access is not Restricted;
 * `exempt`, it lets paths through the portal; `domain`, it declares a domain.
 */
export type TokenProject = { slug: string; open: boolean; exempt: boolean; domain: boolean }

/** The projects a token may be given: every one on the server but the platform's own, which the steward refuses. Sorted. */
export function tokenProjects(sites: readonly Pick<Site, "slug" | "portal" | "domain">[], zone: string | null): TokenProject[] {
  return sites
    .filter((site) => !isPlatform(site.slug, zone))
    .map((site) => ({ slug: site.slug, open: !site.portal.wanted, exempt: site.portal.exemptions.length > 0, domain: site.domain !== null }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * The options the projects chosen cannot be deployed without, each with the
 * projects that ask for it. The steward refuses the rest (src/control/policy.ts):
 * an owner's token deploys a project that is not Restricted only with public
 * sites, a person's deploys it as it stands (`decideDoor`); exempted paths
 * take public sites and a declared domain takes its option from both
 * (`scopeRefusals`). `member`: a person's token.
 */
export function neededOptions(projects: readonly TokenProject[], chosen: readonly string[], member: boolean): { public: string[]; domain: string[] } {
  const picked = projects.filter((project) => chosen.includes(project.slug))
  return {
    public: picked.filter((project) => project.exempt || (!member && project.open)).map((project) => project.slug),
    domain: picked.filter((project) => project.domain).map((project) => project.slug),
  }
}

/** Why an option is ticked for the owner: "Needed by cms", "Needed by cms and shop", "Needed by blog, cms and 2 more". */
export function neededLine(slugs: readonly string[]): string {
  if (slugs.length <= 2) return `Needed by ${slugs.join(" and ")}`
  if (slugs.length === 3) return `Needed by ${slugs[0]}, ${slugs[1]} and ${slugs[2]}`
  return `Needed by ${slugs[0]}, ${slugs[1]} and ${slugs.length - 2} more`
}

export function firstTokenField(errors: TokenErrors): TokenField | null {
  for (const field of ["label", "slugs"] as const) if (errors[field] !== undefined) return field
  return null
}

/**
 * Who a token may be made for by the owner: the people who deploy somewhere,
 * a Developer or an Admin, or may create projects. A Viewer everywhere signs
 * in, but the steward mints them no token, so the dialog does not offer them.
 */
export function tokenHolders(people: readonly { who: string; roles: Readonly<Record<string, Role | "visitor">>; create: boolean }[]): { email: string; roles: Roles; create: boolean }[] {
  return people
    .map((person) => ({
      email: person.who,
      roles: Object.fromEntries(Object.entries(person.roles).filter((entry): entry is [string, Role] => entry[1] !== "visitor")) as Roles,
      create: person.create,
    }))
    .filter((person) => person.create || mintableProjects(person.roles).length > 0)
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
 * What the token dialog says when the person it is for has no project it
 * may deploy: no project at all yet, or a Viewer on each. *New projects*,
 * right below, says whether it may still create some. `holder`: the person,
 * when the owner makes it for them; null for one's own.
 */
export function noProjectText(roles: Roles, holder: string | null): string {
  if (Object.keys(roles).length === 0) return holder === null ? "No project yet." : `${holder} has no project yet.`
  return holder === null ? "None of your projects: you are a Viewer on each." : `None of ${holder}'s projects: a Viewer on each.`
}

/**
 * A person the owner may make a token for, in one line under their email:
 * where they deploy, then whether they may create projects. "Admin on
 * calendar, Developer on cms", "Developer or Admin on 4 projects · May create
 * projects", "Viewer only".
 */
export function holderLine(holder: { roles: Roles; create: boolean }): string {
  const deploys = mintableProjects(holder.roles)
  const parts: string[] = []
  if (deploys.length > 0 && deploys.length <= 2) parts.push(deploys.map(({ slug, role }) => `${ROLE_WORDS[role]} on ${slug}`).join(", "))
  if (deploys.length > 2) parts.push(`Developer or Admin on ${deploys.length} projects`)
  if (holder.create) parts.push("May create projects")
  if (parts.length === 0) return "Viewer only"
  return parts.join(" · ")
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
