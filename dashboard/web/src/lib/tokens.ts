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
import { isPlatform } from "./access"
import { ago, dateTime, duration, fromNow } from "./format"
import { normalize } from "./search"
import type { Tone } from "./tones"
import type { Scope, Site, TokenView } from "./types"

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
 * The address a token from before every token was the owner's was made for,
 * kept as a label; null for the owner's own.
 */
export function madeFor(token: Pick<TokenView, "email">): string | null {
  return token.email === "owner" ? null : token.email
}

// --- What a token may do --------------------------------------------------------------

/** What a token may do beyond deploying its projects, one key each. */
export type PermissionKey = "all" | "public" | "secrets" | "domain" | "outbound" | "create"

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
  all: {
    chip: "Every project",
    title: "Deploys every project, as you",
    sentence: "Every project on the server, and every permission below: what you deploy with, now that no deployment goes over SSH. It may also take a name back from another token, and replace a unit or a block edited by hand (--force).",
    phrase: "every project, as you",
  },
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
export const PERMISSION_ORDER: readonly PermissionKey[] = ["all", "public", "secrets", "domain", "outbound", "create"]

/**
 * What a token may do beyond deploying, what is on alone: nothing is said of
 * what is off, which is every token's default.
 */
export function tokenPermissions(token: Pick<TokenView, "scope">): PermissionKey[] {
  const { scope } = token
  // `secrets` absent from a scope minted before the permission: none.
  const on: Record<PermissionKey, boolean> = { all: scope.all === true, public: scope.public, secrets: scope.secrets === true, domain: scope.domain, outbound: scope.outbound, create: scope.create }
  return PERMISSION_ORDER.filter((key) => on[key])
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

/** The characters a Permissions or Projects cell holds at the table's narrowest one-line width. */
export const CELL_BUDGET = 24

/** The Permissions cell, in their order. */
export function permissionChips(permissions: readonly PermissionKey[]): { shown: PermissionKey[]; more: number } {
  return fitChips(permissions, (key) => PERMISSION_WORDS[key].chip.length, { budget: CELL_BUDGET })
}

/** The Projects cell. */
export function projectChips(reach: readonly Reach[]): { shown: Reach[]; more: number } {
  return fitChips(reach, (one) => one.slug.length, { budget: CELL_BUDGET })
}

/** Does a token answer the list's search: its name, the address it was made for, a project it reaches. */
export function tokenMatches(token: Pick<TokenView, "label" | "email" | "owned" | "scope">, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter((word) => word !== "")
  const haystack = normalize([token.label, madeFor(token) ?? "", ...token.owned, ...token.scope.slugs].join(" "))
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
 * a token deploys a project that is not Restricted only with public sites
 * (`decideDoor`); exempted paths take public sites and a declared domain
 * takes its option (`scopeRefusals`).
 */
export function neededOptions(projects: readonly TokenProject[], chosen: readonly string[]): { public: string[]; domain: string[] } {
  const picked = projects.filter((project) => chosen.includes(project.slug))
  return {
    public: picked.filter((project) => project.exempt || project.open).map((project) => project.slug),
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

/** A project a token reaches, and what the sheet says beside it: "created" for those it created. */
export type Reach = { slug: string; detail: string | null }

/** Does a token deploy every project, as the owner: its scope's `slugs` is then empty, which says nothing of its reach. */
export function reachesEveryProject(token: Pick<TokenView, "scope">): boolean {
  return token.scope.all === true
}

/** Where a token deploys: each project it created or was given. */
export function liveReach(token: Pick<TokenView, "owned" | "scope">): Reach[] {
  return reachedProjects(token).map(({ slug, how }) => ({ slug, detail: how === "created" ? "created" : null }))
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
  const { secrets, all, ...rest } = choices
  return { ...rest, slugs: [...slugs], ...(secrets === true ? { secrets: true } : {}), ...(all === true ? { all: true } : {}) }
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
  // A scope the steward refuses: its words, each reason without its field's prefix.
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
  const choice = EXPIRY_CHOICES.find((one) => one.days === expiryDays)
  const expires = expiryDays === null ? "never expires" : `expires in ${choice?.label ?? `${expiryDays} days`}`
  // Every project, as the owner: every permission comes with it, the projects ticked or not.
  if (permissions.includes("all")) return `Deploys every project as you, with every permission, ${expires}.`
  const names = slugs.length === 0 ? null : slugs.length <= 2 ? slugs.join(" and ") : `${slugs.length} projects`
  const deploys = names === null ? (create ? "Deploys the new projects it creates" : "Deploys nothing yet") : `Deploys ${names}${create ? " and new projects" : ""}`
  const ordered = PERMISSION_ORDER.filter((key): key is Exclude<PermissionKey, "create"> => key !== "create" && permissions.includes(key as Exclude<PermissionKey, "create">))
  const phrases = ordered.map((key) => PERMISSION_WORDS[key].phrase)
  const extra = phrases.length === 0 ? "no extra permission" : `with ${phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`}`
  return `${deploys}, ${expires}, ${extra}.`
}
