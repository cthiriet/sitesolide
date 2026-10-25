/**
 * What the Tokens page decides: a token's state and its cells, its
 * permissions and projects as chips, the form's own checks and its summary,
 * the login command. Pure: the clock arrives as a parameter.
 *
 * The rules of who may deploy what are not here: the steward judges a token's
 * request and the page shows its refusal. The form only refuses what it can
 * see is empty or malformed, so that the owner does not wait for a round trip
 * to learn a field is missing.
 */
import { isPlatform, roleLabel } from "./access"
import { ago, dateTime, duration, fromNow } from "./format"
import { normalize } from "./search"
import type { Tone } from "./tones"
import type { Role, Roles, Scope, Site, TokenView } from "./types"

const DAY = 24 * 60 * 60 * 1000

/** Within this, an expiry is worth a look. */
const EXPIRY_WARNING_MS = 7 * DAY

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

/** A token's state, as one word and its tone: the sheet's, quiet while it is active. */
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
 * The tokens the list shows, and those it folds under "Show 1 revoked or
 * expired": a token that no longer deploys is history, not something to act on.
 */
export function splitTokens<T extends Pick<TokenView, "revokedAt" | "expiresAt">>(tokens: readonly T[], now: number): { live: T[]; ended: T[] } {
  return { live: tokens.filter((token) => isLive(token, now)), ended: tokens.filter((token) => !isLive(token, now)) }
}

/** The fold's line: "Show 1 revoked or expired", "Hide 2 revoked or expired". */
export function foldLabel(count: number, open: boolean): string {
  return `${open ? "Hide" : "Show"} ${count} revoked or expired`
}

/**
 * A short date in the reader's time zone, "Jan 21", with its year when it is
 * not the current one, "Jan 21, 2027". The time zone is a parameter for the
 * tests; the page takes the browser's.
 */
export function shortDate(ms: number, now: number, timeZone?: string): string {
  const year = (at: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(at)
  const parts = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  const day = `${value("month")} ${value("day")}`
  return year(ms) === year(now) ? day : `${day}, ${year(ms)}`
}

/**
 * The Expires cell: a date while far, "in 4d" in attention within a week,
 * "No expiry", "Expired" or "Revoked" muted. `title`, the whole date and
 * time, for its tooltip.
 */
export type ExpiryCell = { text: string; tone: "plain" | "muted" | "attention"; title: string | null }

export function expiryCell(token: Pick<TokenView, "revokedAt" | "expiresAt">, now: number, timeZone?: string): ExpiryCell {
  if (token.revokedAt !== null) return { text: "Revoked", tone: "muted", title: `Revoked ${dateTime(token.revokedAt, timeZone)}` }
  if (token.expiresAt === null) return { text: "No expiry", tone: "muted", title: null }
  const title = dateTime(token.expiresAt, timeZone)
  if (now >= token.expiresAt) return { text: "Expired", tone: "muted", title: `Expired ${title}` }
  if (token.expiresAt - now <= EXPIRY_WARNING_MS) return { text: fromNow(token.expiresAt - now), tone: "attention", title }
  return { text: shortDate(token.expiresAt, now, timeZone), tone: "plain", title }
}

/** The Last used cell: "5h ago", or "Never". */
export function lastUsed(token: Pick<TokenView, "lastUsedAt">, now: number): string {
  return token.lastUsedAt === null ? "Never" : ago(now - token.lastUsedAt)
}

/**
 * Whose a token is, in the Owner column: "You" for the owner's own, the
 * person's email for theirs; a token from before every token belonged to
 * someone keeps the address it was made for.
 */
export function ownerLabel(token: Pick<TokenView, "member" | "email">): string {
  if (token.member !== null) return token.member
  return token.email === "owner" ? "You" : token.email
}

// --- What a token may do --------------------------------------------------------------

/** What a token may do beyond deploying its projects, one key each. */
export type PermissionKey = "public" | "secrets" | "domain" | "outbound" | "create"

export type PermissionWords = {
  /** The row's chip: short, "Public sites". */
  chip: string
  /** The sheet's line and the chip's tooltip: "Can deploy public sites". */
  title: string
  /** What it allows, in the sheet. */
  sentence: string
  /** In the dialog's summary: "with public sites and secrets". */
  phrase: string
}

export const PERMISSION_WORDS: Readonly<Record<PermissionKey, PermissionWords>> = {
  public: { chip: "Public sites", title: "Can deploy public sites", sentence: "Sites anyone opens without signing in.", phrase: "public sites" },
  secrets: {
    chip: "Secrets",
    title: "Can manage secrets",
    sentence: "Lists each project's secret names, and sets, generates and removes its variables and files on the server. Never reads a value back.",
    phrase: "secrets",
  },
  domain: { chip: "Domain", title: "Can declare a domain", sentence: "A domain of its own in sitesolide.json.", phrase: "a domain" },
  outbound: { chip: "Network", title: "Can use outbound network", sentence: "For services that call an outside API.", phrase: "outbound network" },
  create: { chip: "New projects", title: "Can create projects", sentence: "Projects it creates itself, which it then deploys.", phrase: "new projects" },
}

/** The order of the chips and the sheet's lines: what opens a site to anyone first. */
export const PERMISSION_ORDER: readonly PermissionKey[] = ["public", "secrets", "domain", "outbound", "create"]

/** A permission a token holds, and why it is paused, when it is: "no longer allowed". */
export type Permission = { key: PermissionKey; pause: string | null }

/** A scope's permissions, what is on alone: nothing is said of what is off, which is every token's default. */
function heldPermissions(scope: Scope): PermissionKey[] {
  // `secrets` absent from a scope minted before the permission: none.
  const on: Record<PermissionKey, boolean> = { public: scope.public, secrets: scope.secrets === true, domain: scope.domain, outbound: scope.outbound, create: scope.create }
  return PERMISSION_ORDER.filter((key) => on[key])
}

/** What a person holds now: their role on each project, and the right to create projects. */
export type Rights = { roles: Readonly<Record<string, Role | "visitor">>; create: boolean }

/**
 * What a token may do beyond deploying, what is on alone, a person's paused
 * while they no longer hold it, as the steward narrows it at every use
 * (src/people/tokens.ts, `narrowIdentity`): the create right while they hold
 * it, "no longer allowed"; each option while they are Admin of every project
 * the token still deploys, "not Admin of cms now"; managing secrets while it
 * still deploys a project or may create one, the steward judging the role on
 * each project at every request, "no project to deploy now". `rights` null:
 * the owner's own, or rights not known.
 */
export function tokenPermissions(token: Pick<TokenView, "owned" | "scope" | "member">, rights: Rights | null): Permission[] {
  const held = heldPermissions(token.scope)
  if (token.member === null || rights === null) return held.map((key) => ({ key, pause: null }))
  const roleOf = (slug: string) => (Object.hasOwn(rights.roles, slug) ? rights.roles[slug]! : null)
  const deploys = (slug: string) => roleOf(slug) === "developer" || roleOf(slug) === "admin"
  const reached = [...new Set([...token.scope.slugs, ...token.owned])].filter(deploys).sort()
  const create = token.scope.create && rights.create
  const notAdmin = reached.filter((slug) => roleOf(slug) !== "admin")
  const nothing = reached.length === 0 && !create ? "no project to deploy now" : null
  const optionPause = nothing ?? (notAdmin.length > 0 ? `not Admin of ${notAdmin.join(", ")} now` : null)
  return held.map((key) => ({ key, pause: key === "create" ? (rights.create ? null : "no longer allowed") : key === "secrets" ? nothing : optionPause }))
}

/**
 * At most `max` chips in a cell, the rest as "+N": each is shown while the
 * room left takes it, the first always, a "+N" kept room for while more
 * follow. `width` counts in characters, the room in `budget`.
 */
export function fitChips<T>(items: readonly T[], width: (item: T) => number, { max = 2, budget }: { max?: number; budget: number }): { shown: T[]; more: number } {
  const shown: T[] = []
  let used = 0
  for (const [index, item] of items.entries()) {
    const after = items.length - index - 1
    const needs = used + width(item) + (after > 0 ? MORE_WIDTH : 0)
    if (shown.length >= max || (shown.length > 0 && needs > budget)) break
    shown.push(item)
    used += width(item) + CHIP_GAP
  }
  return { shown, more: items.length - shown.length }
}

/** What a "+2" takes in a cell, and the gap between two chips, in characters. */
const MORE_WIDTH = 3
const CHIP_GAP = 1

/** A paused chip carries its glyph, two characters' worth. */
const PAUSE_WIDTH = 2

/** The characters a Permissions or Projects cell holds at the table's narrowest one-line width. */
export const CELL_BUDGET = 24

/** The Permissions cell: the live first, in their order, the paused after. */
export function permissionChips(permissions: readonly Permission[]): { shown: Permission[]; more: number } {
  const ordered = [...permissions.filter((one) => one.pause === null), ...permissions.filter((one) => one.pause !== null)]
  return fitChips(ordered, (one) => PERMISSION_WORDS[one.key].chip.length + (one.pause === null ? 0 : PAUSE_WIDTH), { budget: CELL_BUDGET })
}

/** The Projects cell: where it deploys first, then where it is paused. */
export function projectChips(reach: readonly Reach[]): { shown: Reach[]; more: number } {
  const ordered = [...reach.filter((one) => !one.paused), ...reach.filter((one) => one.paused)]
  return fitChips(ordered, (one) => one.slug.length + (one.paused ? PAUSE_WIDTH : 0), { budget: CELL_BUDGET })
}

/** Does a token answer the list's search: its name, its owner, a project it reaches. */
export function tokenMatches(token: Pick<TokenView, "label" | "member" | "email" | "owned" | "scope">, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter((word) => word !== "")
  const haystack = normalize([token.label, ownerLabel(token), ...token.owned, ...token.scope.slugs].join(" "))
  return words.every((word) => haystack.includes(word))
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
export function tokenHolders(people: readonly (Rights & { who: string })[]): { email: string; roles: Roles; create: boolean }[] {
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

/**
 * A project a token reaches, and what the sheet says beside it: a person's
 * role there today, "Admin", or why it is paused, "Viewer now", "no role
 * now"; for the owner's own, "created" for those it created.
 */
export type Reach = { slug: string; detail: string | null; paused: boolean }

/**
 * Where a token deploys now: each project it was given or created. A
 * person's, with that person's role there today; below Developer, it is
 * paused there until the role comes back. The owner's own says which
 * projects it created.
 */
export function liveReach(token: Pick<TokenView, "owned" | "scope" | "member">, roles: Rights["roles"] | null): Reach[] {
  const projects = reachedProjects(token)
  if (token.member === null || roles === null) {
    return projects.map(({ slug, how }) => ({ slug, detail: how === "created" ? "created" : null, paused: false }))
  }
  return projects.map(({ slug }) => {
    const role = Object.hasOwn(roles, slug) ? roles[slug]! : null
    if (role === "developer" || role === "admin") return { slug, detail: roleLabel(role), paused: false }
    return { slug, detail: `${role === null ? "no role" : roleLabel(role)} now`, paused: true }
  })
}

/** The command the holder runs, without the token: typed at its prompt, it never lands in a shell history. */
export function loginCommand(origin: string): string {
  return `sitesolide login --url ${origin}`
}

/** What the holder receives, ready to paste in a message: the address, the command, the token. */
export function messageText(origin: string, secret: string): string {
  return [`Dashboard: ${origin}`, `Sign in: ${loginCommand(origin)}`, `Token (paste it at the prompt): ${secret}`].join("\n")
}

/**
 * What the dialog sends of its permissions: `secrets` only when ticked, so
 * that a token without it is minted by a steward that predates the
 * permission, which refuses any field it does not know.
 */
export function requestScope(choices: Omit<Scope, "slugs">, slugs: readonly string[]): Scope {
  const { secrets, ...rest } = choices
  return { ...rest, slugs: [...slugs], ...(secrets === true ? { secrets: true } : {}) }
}

/** What an older steward says of a scope carrying a field it does not know: `secrets`, the only one the dialog may add. */
const UNEXPECTED_SCOPE_FIELD = "unexpected field in the scope"

export const STEWARD_PREDATES_SECRETS = "The server's steward predates this permission: run sitesolide upgrade."

/** The refusal of a creation, under the field it concerns when the steward's message names one. */
export function tokenRefusal(status: number, body: { error?: string; message?: string } | null): { field: TokenField | null; message: string } {
  const message = body?.message ?? (status === 0 ? "Can't reach the dashboard." : `Refused (${status}).`)
  if (status === 400 && message === UNEXPECTED_SCOPE_FIELD) return { field: null, message: STEWARD_PREDATES_SECRETS }
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

// --- The dialog's summary ------------------------------------------------------------

/**
 * The New token dialog's one line above its buttons, what the token will be
 * once created: "Deploys cms and photos, expires in 90 days, no extra
 * permission." `permissions`: what is ticked beyond deploying, the create
 * right aside, which `create` says.
 */
export function tokenSummary({
  slugs,
  create,
  permissions,
  expiryDays,
}: {
  slugs: readonly string[]
  create: boolean
  permissions: readonly Exclude<PermissionKey, "create">[]
  expiryDays: number | null
}): string {
  const names = slugs.length === 0 ? null : slugs.length <= 2 ? slugs.join(" and ") : `${slugs.length} projects`
  const deploys = names === null ? (create ? "Deploys the new projects it creates" : "Deploys nothing yet") : `Deploys ${names}${create ? " and new projects" : ""}`
  const choice = EXPIRY_CHOICES.find((one) => one.days === expiryDays)
  const expires = expiryDays === null ? "never expires" : `expires in ${choice?.label ?? `${expiryDays} days`}`
  const ordered = PERMISSION_ORDER.filter((key): key is Exclude<PermissionKey, "create"> => key !== "create" && permissions.includes(key as Exclude<PermissionKey, "create">))
  const phrases = ordered.map((key) => PERMISSION_WORDS[key].phrase)
  const extra = phrases.length === 0 ? "no extra permission" : `with ${phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`}`
  return `${deploys}, ${expires}, ${extra}.`
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
  if (deploys.length > 0 && deploys.length <= 2) parts.push(deploys.map(({ slug, role }) => `${roleLabel(role)} on ${slug}`).join(", "))
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
