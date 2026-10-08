/**
 * What the Activity page decides: the query it sends, the words of each row,
 * the detail as lines of text, and the exports. Pure apart from the call,
 * tested by tests/audit.test.ts.
 *
 * The page judges nothing about an audit row. It asks `/api/audit`, which
 * reads every component's own audit, and shows what comes back. A row's
 * detail is data from a component, rendered as text and never as markup.
 */
import { callApi } from "./api"
import { activityLine } from "./connectors"
import { dateTime } from "./format"
import { operationOutcome, operationParts } from "./secrets"
import type { Tone } from "./tones"
import type { AuditResponse, AuditRow, AuditSource, LogEntry, Operation, SourceStatus } from "./types"

// --- The sources -----------------------------------------------------------------

export type SourceEntry = { key: AuditSource; label: string; description: string }

/** In the order the server lists them. */
export const SOURCES: readonly SourceEntry[] = [
  { key: "dashboard", label: "Dashboard", description: "Tokens, and the deployments they make" },
  { key: "portal", label: "Portal", description: "Sign-ins and sign-outs on restricted sites" },
  { key: "egress", label: "Egress", description: "Refused destinations, connector calls and changes" },
  { key: "backups", label: "Backups", description: "Scheduled runs and restores" },
  { key: "steward", label: "Access", description: "Who may do what, secrets and restarts" },
]

export function sourceLabel(source: AuditSource): string {
  return SOURCES.find((entry) => entry.key === source)?.label ?? source
}

/** A source's state in a word and a tone: what the strip at the top of the page says. */
export function sourceWords(status: SourceStatus): { word: string; tone: Tone } {
  switch (status.state) {
    case "ok":
      return status.window === null ? { word: "Read", tone: "ok" } : { word: `Latest ${status.window}`, tone: "ok" }
    case "unavailable":
      return { word: "Can't read", tone: "error" }
    case "outdated":
      return { word: "Needs updating", tone: "attention" }
    case "not-installed":
      return { word: "Not installed", tone: "neutral" }
  }
}

/**
 * What the page knows of each source, kept from one answer to the next: a
 * page further down the log reads only the sources that still have rows, and
 * the others keep the state they had.
 */
export function mergeStatuses(known: readonly SourceStatus[], received: readonly SourceStatus[]): SourceStatus[] {
  const byName = new Map(known.map((status) => [status.name, status]))
  for (const status of received) byName.set(status.name, status)
  return SOURCES.flatMap((entry) => {
    const status = byName.get(entry.key)
    return status === undefined ? [] : [status]
  })
}

/**
 * Which sources the dashboard only reads the latest entries of, once the log
 * has reached their end: older ones stay on the server, and the page says so
 * rather than let the end of the list pass for the beginning of time.
 */
export function windowNote(statuses: readonly SourceStatus[]): string | null {
  const limited = statuses.filter((status) => status.state === "ok" && status.window !== null)
  if (limited.length === 0) return null
  const names = limited.map((status) => sourceLabel(status.name))
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`
  const window = limited[0]!.window!
  const verb = names.length === 1 ? "hands" : "hand"
  return `${who} ${verb} the dashboard ${names.length === 1 ? "its" : "their"} latest ${window} entries; older ones stay on the server.`
}

/** What the toolbar says on its right: how many, in which order. */
export function countWords(shown: number, narrowed: boolean): string {
  const noun = shown === 1 ? "event" : "events"
  return `${shown} ${narrowed ? `matching ${noun}` : noun}${shown > 1 ? ", newest first" : ""}`
}

// --- The query -------------------------------------------------------------------

export type AuditFilters = {
  /** One source, or every one. */
  source: AuditSource | null
  actor: string
  action: string
  target: string
  /** `yyyy-mm-dd`, in the browser's time zone, as a date field gives it. */
  from: string
  to: string
}

export const NO_FILTERS: AuditFilters = { source: null, actor: "", action: "", target: "", from: "", to: "" }

/** The action every access change starts with: someone given access, changed or taken off, a site restricted or made public. */
export const ACCESS_ACTION = "access"

/** Is the log narrowed to access changes, the filter the toolbar offers as a chip? */
export function accessOnly(filters: AuditFilters): boolean {
  return filters.action.trim().toLowerCase() === ACCESS_ACTION
}

/**
 * The filters an address asks for, `/activity/?action=access&target=cms`
 * from a site's Access section; anything else starts empty.
 */
export function filtersFrom(params: { get: (name: string) => string | null }): AuditFilters {
  const value = (name: string) => (params.get(name) ?? "").slice(0, 200)
  const source = SOURCES.find((entry) => entry.key === params.get("source"))?.key ?? null
  return { ...NO_FILTERS, source, actor: value("actor"), action: value("action"), target: value("target") }
}

/** The Activity page's address, narrowed: what a link from elsewhere opens. */
export function activityUrl(filters: Partial<Pick<AuditFilters, "action" | "target" | "actor">>): string {
  const query = new URLSearchParams()
  for (const key of ["actor", "action", "target"] as const) {
    const value = filters[key]?.trim() ?? ""
    if (value !== "") query.set(key, value)
  }
  const text = query.toString()
  return `/activity/${text === "" ? "" : `?${text}`}`
}

export function hasFilters(filters: AuditFilters): boolean {
  return (
    filters.source !== null ||
    filters.actor.trim() !== "" ||
    filters.action.trim() !== "" ||
    filters.target.trim() !== "" ||
    filters.from !== "" ||
    filters.to !== ""
  )
}

/** Midnight of a `yyyy-mm-dd` day in the browser's time zone, `days` later; null when it does not read. */
function midnight(day: string, days = 0): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (parts === null) return null
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + days)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The page asked for, rows newest first. */
export const PAGE_SIZE = 100

/**
 * The query string of `/api/audit`. The days are whole days where the person
 * is: `to` includes its day, so the server, which takes it exclusive, gets the
 * next midnight.
 */
export function auditQuery(filters: AuditFilters, cursor: string | null = null, limit = PAGE_SIZE): string {
  const query = new URLSearchParams()
  if (filters.source !== null) query.set("source", filters.source)
  for (const key of ["actor", "action", "target"] as const) {
    const value = filters[key].trim()
    if (value !== "") query.set(key, value)
  }
  const from = midnight(filters.from)
  const to = midnight(filters.to, 1)
  if (from !== null) query.set("from", from.toISOString())
  if (to !== null) query.set("to", to.toISOString())
  query.set("limit", String(limit))
  if (cursor !== null) query.set("cursor", cursor)
  return `?${query}`
}

export function readAudit(query: string) {
  return callApi<AuditResponse & { error?: string; message?: string }>(`/api/audit${query}`)
}

/** True when an answer has the shape the page reads; anything else is a failure to say. */
export function isAuditResponse(body: unknown): body is AuditResponse {
  if (typeof body !== "object" || body === null) return false
  const { rows, sources, cursor } = body as Record<string, unknown>
  return Array.isArray(rows) && Array.isArray(sources) && (cursor === null || typeof cursor === "string")
}

/**
 * The newest page read again, put in front of the rows already there. If it
 * does not reach them, rows may have come in between that neither holds: the
 * log starts over from the newest page rather than show a hole.
 */
export function refreshRows(current: readonly AuditRow[], newest: AuditResponse): { rows: AuditRow[]; restart: boolean } {
  const known = new Set(current.map((row) => row.id))
  const reaches = current.length === 0 || newest.cursor === null || newest.rows.some((row) => known.has(row.id))
  if (!reaches) return { rows: newest.rows, restart: true }
  const fresh = newest.rows.filter((row) => !known.has(row.id))
  return { rows: [...fresh, ...current], restart: false }
}

// --- A row in words --------------------------------------------------------------

export type AuditWords = {
  /** What happened, in a sentence. */
  summary: string
  /** A second line: how it ended, why, how many. */
  note: string | null
  tone: Tone
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const times = (n: number | null) => (n === null || n <= 1 ? null : `${n} times`)

/** Why the portal refused a sign-in, in words. An unknown reason is shown as it is. */
const SIGNIN_REFUSALS: Readonly<Record<string, string>> = {
  "domain-not-allowed": "domain not allowed",
  "unmanaged-account": "not a company account",
  "unverified-email": "email not verified",
  "no-email": "no email shared",
  "unusable-email": "unusable email",
  "provider-error": "cancelled or refused by the provider",
  "provider-unreachable": "provider unreachable",
  "not-shared": "no access to the site",
  "expired-session": "session expired",
}

const SHARING_MODES: Readonly<Record<string, string>> = {
  admins: "only admins",
  people: "specific people",
  domain: "everyone at a domain",
}

/** Through Object.hasOwn: a value reading "constructor" finds nothing. */
function word(table: Readonly<Record<string, string>>, key: string | null): string | null {
  return key !== null && Object.hasOwn(table, key) ? table[key]! : key
}

/**
 * The steward's operations on secrets, general access and services, as
 * distinct from its access and sign-in events and from an Admin's change it
 * refused before it reached the portal or the backups, which record those
 * that go through.
 */
type StewardOperation = Exclude<
  Operation,
  | `member.${string}`
  | `access.${string}`
  | `dashboard.${string}`
  | "people.create"
  | "sharing"
  | "guest.create"
  | "guest.revoke"
  | "backup.restore"
  | "token.create"
  | "token.revoke"
  | "project.create"
  | "project.remove"
>

/** What an Admin's change the steward refused tried to do, in rows written before the access registry. */
const REFUSED_CHANGES: Readonly<Record<string, string>> = {
  "sharing.update": "Tried to change who can open it",
  "guest.create": "Tried to give password access",
  "guest.revoke": "Tried to remove password access",
  "backup.restore": "Tried to restore a snapshot",
}

/** A person's role, or its absence, as the steward journals a refusal by role. */
function roleNote(note: string | null): string | null {
  if (note === null) return null
  if (note === "no role") return "Refused: no role on this project"
  const role = note.startsWith("role ") ? note.slice("role ".length) : null
  return role === null ? `Refused: ${note}` : `Refused: ${Object.hasOwn(ROLE_WORDS, role) ? ROLE_WORDS[role] : role} here`
}

/** The steward's operation behind an action, for the words its own Activity always used. */
const STEWARD_OPERATIONS: Readonly<Record<string, StewardOperation>> = {
  "secrets.unlock": "unlock",
  "secrets.lock": "lock",
  "secrets.read": "read",
  "secrets.set": "set",
  "secrets.remove": "remove",
  "secrets.create": "create",
  "secrets.restore": "restore",
  "secrets.replace": "replace",
  "secrets.password": "password",
  "access.general": "portal",
  "access.code": "code",
  "service.restart": "restart",
}

const DONE: Readonly<Record<StewardOperation, string>> = {
  unlock: "Unlocked changes",
  lock: "Locked changes",
  read: "Read",
  set: "Set",
  remove: "Removed",
  create: "Created",
  restore: "Restored the previous",
  replace: "Replaced",
  password: "Changed",
  portal: "Changed general access",
  code: "Gave a new code",
  restart: "Restarted",
}

const TRIED: Readonly<Record<StewardOperation, string>> = {
  unlock: "Tried to unlock changes",
  lock: "Tried to lock changes",
  read: "Tried to read",
  set: "Tried to set",
  remove: "Tried to remove",
  create: "Tried to create",
  restore: "Tried to restore the previous",
  replace: "Tried to replace",
  password: "Tried to change",
  portal: "Tried to change general access",
  code: "Tried to give a new code",
  restart: "Tried to restart",
}

/** Why the steward refused a person's sign-in, in words. An unknown reason is shown as it is. */
const MEMBER_REFUSALS: Readonly<Record<string, string>> = {
  "not-a-member": "no access to any project",
  "no-role": "no access to any project",
  "can-open-only": "Can open only: the dashboard starts at Viewer",
  "replayed-assertion": "sign-in already used",
  "stale-authentication": "sign-in at the provider too old",
  "too-many-sign-ins": "too many sign-ins",
  "unknown-key": "signed by another key",
  "bad-signature": "signature does not verify",
  expired: "sign-in expired",
}

function stewardWords(row: AuditRow, operation: StewardOperation): AuditWords {
  const detail = row.detail ?? {}
  const result = text(detail.result)
  const entry: LogEntry = {
    a: Date.parse(row.at),
    operation,
    result: result === "rejects" || result === "failure" ? result : "ok",
    actor: row.actor,
    member: null,
    slug: row.target,
    file: text(detail.file),
    variable: text(detail.variable),
    detail: text(detail.note),
  }
  const outcome = operationOutcome(entry)
  const ok = entry.result === "ok"
  const tone: Tone = outcome.tone === "ok" ? "neutral" : outcome.tone
  if (operation === "portal") {
    // The journal writes the direction first: "on, ok" restricted the site,
    // "off, failure" tried to make it public, "code, ok" opened it with a code.
    const direction = entry.detail?.split(",")[0]?.trim()
    const site = row.target ?? "it"
    const summary =
      direction === "on"
        ? ok
          ? `Restricted ${site}`
          : `Tried to restrict ${site}`
        : direction === "off"
          ? ok
            ? `Made ${site} public`
            : `Tried to make ${site} public`
          : direction === "code"
            ? ok
              ? `Set ${site} to Anyone with the code`
              : `Tried to set ${site} to Anyone with the code`
            : ok
              ? DONE.portal
              : TRIED.portal
    return { summary, note: ok ? null : entry.result === "rejects" ? "Refused" : "Failed", tone }
  }
  if (operation === "code") {
    // A new code, never the code itself: the journal does not hold it.
    const site = row.target ?? "it"
    return { summary: ok ? `Gave ${site} a new code` : `Tried to give ${site} a new code`, note: ok ? null : entry.result === "rejects" ? "Refused" : "Failed", tone }
  }
  const { object, kind } = operationParts(entry)
  // A site already shows in its own column.
  const named = object !== null && kind !== "project" ? ` ${object}` : ""
  return { summary: `${ok ? DONE[operation] : TRIED[operation]}${named}`, note: outcome.text, tone }
}

/** The ladder's roles as the page says them, `admin` included for an admin email's sign-in. */
const ROLE_WORDS: Readonly<Record<string, string>> = { visitor: "Can open", viewer: "Viewer", developer: "Developer", admin: "Admin" }

/**
 * The steward's note on an access change, `dana@example.com: Developer ->
 * Can open`: who it is about, and the rest. A note that does not read that
 * way keeps the person the row names, and the note whole.
 */
function splitNote(note: string | null, member: string | null): { who: string; rest: string | null } {
  if (note === null) return { who: member ?? "someone", rest: null }
  const cut = note.indexOf(": ")
  if (cut <= 0) return { who: member ?? "someone", rest: note }
  return { who: note.slice(0, cut), rest: note.slice(cut + 2) }
}

/**
 * Someone given access, changed or taken off, in a sentence that names them,
 * their role and the site: "Gave dana@example.com Developer on cms",
 * "Changed dana@example.com from Developer to Can open on cms".
 */
/**
 * A password access's end as the journal writes it, "until 2026-10-15 05:38
 * UTC", said as the rest of the dashboard says a time: local, its zone named.
 * Anything else, "no expiry" among others, as it was written.
 */
export function expiryNote(until: string, timeZone?: string): string | null {
  if (until === "") return null
  const found = /^until (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(until)
  const ms = found === null ? Number.NaN : Date.parse(`${found[1]}T${found[2]}:00Z`)
  if (Number.isFinite(ms)) return `Until ${dateTime(ms, timeZone)}`
  return until.charAt(0).toUpperCase() + until.slice(1)
}

function accessWords(row: AuditRow, timeZone?: string): AuditWords {
  const detail = row.detail ?? {}
  const site = row.site ?? row.target ?? "a project"
  const member = text(detail.member)
  if (text(detail.result) === "rejects") {
    const who = member ?? "someone"
    const summary = row.action === "access.remove" ? `Tried to remove ${who} from ${site}` : `Tried to give ${who} access to ${site}`
    return { summary, note: text(detail.note), tone: "attention" }
  }
  const { who, rest } = splitNote(text(detail.note), member)
  if (row.action === "access.change") {
    const roles = rest?.split(" -> ") ?? []
    if (roles.length === 2) return { summary: `Changed ${who} from ${roles[0]} to ${roles[1]} on ${site}`, note: null, tone: "neutral" }
    return { summary: `Changed the role of ${who} on ${site}`, note: rest, tone: "neutral" }
  }
  if (row.action === "access.remove") {
    if (rest?.startsWith("taken off everywhere") === true) {
      const was = rest.slice("taken off everywhere".length).replace(/^, /, "")
      return { summary: `Removed ${who} from every project`, note: was === "" ? null : `Was ${was}`, tone: "neutral" }
    }
    const was = rest?.startsWith("was ") === true ? `Was ${rest.slice(4)}` : rest
    return { summary: `Removed ${who} from ${site}`, note: was, tone: "neutral" }
  }
  if (rest?.startsWith("Can open, password access") === true) {
    const until = rest.slice("Can open, password access".length).trim()
    return { summary: `Gave ${who} password access to ${site}`, note: expiryNote(until, timeZone), tone: "neutral" }
  }
  if (who.startsWith("@")) return { summary: `Let everyone at ${who.slice(1)} open ${site}`, note: null, tone: "neutral" }
  if (rest === "Can open") return { summary: `Let ${who} open ${site}`, note: null, tone: "neutral" }
  return { summary: rest === null ? `Gave ${who} access to ${site}` : `Gave ${who} ${rest} on ${site}`, note: null, tone: "neutral" }
}

/**
 * A row in words. An action this page does not know yet is shown as it is,
 * its detail below: a component updated before the page loses nothing. The
 * time zone is a parameter for the tests; the page takes the browser's.
 */
export function auditWords(row: AuditRow, timeZone?: string): AuditWords {
  const detail = row.detail ?? {}
  if (Object.hasOwn(STEWARD_OPERATIONS, row.action) && row.source === "steward") return stewardWords(row, STEWARD_OPERATIONS[row.action]!)
  if (Object.hasOwn(REFUSED_CHANGES, row.action) && row.source === "steward") {
    return { summary: REFUSED_CHANGES[row.action]!, note: roleNote(text(detail.note)), tone: "attention" }
  }
  // An Admin's change of someone's access: the project is the target, the person in the detail.
  const member = text(detail.member)

  switch (row.action) {
    case "access.add":
    case "access.change":
    case "access.remove":
      return accessWords(row, timeZone)
    case "access.migrate":
      return { summary: "Carried who has access over to one registry", note: text(detail.note), tone: "neutral" }
    case "people.create": {
      const { who, rest } = splitNote(text(detail.note), member)
      if (rest === "may create projects") return { summary: `Let ${who} create projects`, note: null, tone: "neutral" }
      if (rest === "may no longer create projects") return { summary: `Took back ${who}'s right to create projects`, note: null, tone: "neutral" }
      return { summary: "Changed who may create projects", note: text(detail.note), tone: "neutral" }
    }
    case "dashboard.signin":
      return { summary: "Signed in to the dashboard", note: null, tone: "neutral" }
    case "dashboard.signin_failed":
      return { summary: "Dashboard sign-in refused", note: word(MEMBER_REFUSALS, text(detail.note)), tone: "attention" }
    case "dashboard.signout":
      return { summary: "Signed out of the dashboard", note: null, tone: "neutral" }
    // Rows written before the access registry, in today's words.
    case "member.invite":
      if (text(detail.result) === "rejects") return { summary: "Tried to give someone a role", note: roleNote(text(detail.note)), tone: "attention" }
      return { summary: `Gave ${member ?? row.target ?? "someone"} a role`, note: text(detail.note), tone: "neutral" }
    case "member.role":
      if (text(detail.result) === "rejects") return { summary: "Tried to change someone's role", note: roleNote(text(detail.note)), tone: "attention" }
      return { summary: `Changed the roles of ${member ?? row.target ?? "someone"}`, note: text(detail.note), tone: "neutral" }
    case "member.remove":
      return { summary: `Took ${member ?? row.target ?? "someone"} off every project`, note: null, tone: "neutral" }
    case "member.signin":
      return { summary: "Signed in to the dashboard with a company account", note: null, tone: "neutral" }
    case "member.signin_failed":
      return { summary: "Dashboard sign-in refused", note: word(MEMBER_REFUSALS, text(detail.note)), tone: "attention" }
    case "member.signout":
      return { summary: "Signed out of the dashboard", note: null, tone: "neutral" }

    case "token.create":
    case "token.revoke": {
      // A person's own token, journaled by the steward: its id and scope in the note.
      if (row.source === "steward") {
        const refused = text(detail.result) === "rejects"
        if (row.action === "token.create") {
          return refused
            ? { summary: "Tried to create a token above their roles", note: text(detail.note), tone: "attention" }
            : { summary: "Created a token of their own", note: text(detail.note), tone: "neutral" }
        }
        return { summary: member === null ? "Revoked a token of their own" : `Revoked the tokens of ${member}`, note: text(detail.note), tone: "neutral" }
      }
      const label = text(detail.label)
      const holder = `${text(detail.email) ?? "someone"}${label === null ? "" : ` (${label})`}`
      return { summary: row.action === "token.create" ? `Created a token for ${holder}` : `Revoked the token of ${holder}`, note: null, tone: "neutral" }
    }
    case "project.create":
      return { summary: "Created the project with a token, Admin of it", note: text(detail.note), tone: "neutral" }
    case "project.remove":
      return { summary: "Removed the project: its name free for another token", note: text(detail.note), tone: "neutral" }
    case "deploy.start":
      return { summary: detail.creating === true ? "Started deploying a new project" : "Started a deployment", note: null, tone: "neutral" }
    case "deploy.success":
      return { summary: detail.creating === true ? "Deployed a new project" : "Deployed", note: null, tone: "neutral" }
    case "deploy.failure":
      return { summary: "Deployment failed", note: text(detail.error), tone: "error" }

    case "portal.signin": {
      const method = text(detail.method)
      const site = row.site ?? row.target ?? "a site"
      if (method === "password") return { summary: "Signed in with the owner's password", note: times(count(detail.count)), tone: "neutral" }
      // Who it was is the actor's column: a password access's name, or an email.
      const role = text(detail.role)
      const as = role !== null && Object.hasOwn(ROLE_WORDS, role) ? ` as ${ROLE_WORDS[role]}` : ""
      return { summary: `Opened ${site}${as}`, note: times(count(detail.count)), tone: "neutral" }
    }
    case "portal.signin_failed": {
      const reason = word(SIGNIN_REFUSALS, text(detail.reason)) ?? (text(detail.method) === "password" ? "wrong password" : null)
      return { summary: "Sign-in refused", note: reason, tone: "attention" }
    }
    case "portal.signout":
      return { summary: `Signed out of ${row.site ?? row.target ?? "a site"}`, note: times(count(detail.count)), tone: "neutral" }
    case "sharing.update": {
      const mode = text(detail.mode)
      const previous = text(detail.previousMode)
      const changes = [
        [list(detail.peopleAdded).length, "person added", "people added"],
        [list(detail.peopleRemoved).length, "person removed", "people removed"],
        [list(detail.domainsAdded).length, "domain added", "domains added"],
        [list(detail.domainsRemoved).length, "domain removed", "domains removed"],
      ] as const
      const note = changes.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many)).join(", ")
      const summary = mode !== null && mode !== previous ? `Changed who can open it to ${word(SHARING_MODES, mode)}` : "Changed who can open it"
      return { summary, note: note === "" ? null : note, tone: "neutral" }
    }

    case "guest.create": {
      const label = text(detail.label)
      return { summary: label === null ? "Gave password access" : `Gave password access to ${label}`, note: null, tone: "neutral" }
    }
    case "guest.revoke": {
      const label = text(detail.label)
      return { summary: label === null ? "Removed a password access" : `Removed the password access of ${label}`, note: null, tone: "neutral" }
    }

    case "egress.denied":
    case "connector.use":
    case "connector.update":
    case "connector.grant": {
      const line = activityLine({ id: 0, at: row.at, actor: row.actor, action: row.action, target: row.target, detail: row.detail === null ? null : JSON.stringify(row.detail) })
      return { summary: line.summary, note: line.detail, tone: line.tone }
    }

    case "backup.run": {
      const failed = list(detail.failed)
      const snapshots = count(detail.snapshots)
      const made = snapshots === null ? null : plural(snapshots, "snapshot", "snapshots")
      if (text(detail.error) !== null) return { summary: "Scheduled backup failed", note: text(detail.error), tone: "error" }
      if (failed.length > 0) return { summary: `Scheduled backup failed for ${plural(failed.length, "site", "sites")}`, note: failed.join(", "), tone: "error" }
      return { summary: "Scheduled backup", note: made, tone: "neutral" }
    }
    case "backup.restore": {
      const result = text(detail.result)
      const snapshot = text(detail.snapshot)
      if (result === "ok") return { summary: snapshot === null ? "Restored a snapshot" : `Restored ${snapshot}`, note: null, tone: "neutral" }
      return { summary: result === "rejects" ? "Restore refused" : "Restore failed", note: text(detail.message), tone: result === "rejects" ? "attention" : "error" }
    }

    default:
      return { summary: row.action, note: null, tone: "neutral" }
  }
}

/**
 * Who acted, by name: the owner; a token's person when the row knows them;
 * a password access by the name it was given under, which the portal writes
 * beside its sign-ins; the server itself; someone not known yet.
 */
export function actorLabel(row: AuditRow): string {
  const email = text(row.detail?.member) ?? text(row.detail?.email)
  if (row.actor === "owner") return "Owner"
  if (row.actor === "system") return "The server"
  if (row.actor === "anonymous") return "Someone"
  if (row.actor.startsWith("token:")) return email === null ? "A token" : `${email} (token)`
  if (row.actor.startsWith("password:") || row.actor.startsWith("guest:")) {
    const name = text(row.detail?.name)
    return name === null ? "Someone with password access" : `${name} (password access)`
  }
  if (text(row.detail?.method) === "password-access") return `${row.actor} (password access)`
  return row.actor
}

// --- The detail, as text ---------------------------------------------------------

export type DetailLine = { key: string; value: string }

/** `peopleAdded` reads "people added"; a key already in words stays as it is. */
export function keyWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
}

function valueText(value: unknown): string {
  if (value === null) return "none"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "string") return value === "" ? "empty" : value
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : valueText(item))).join(", ")
  return JSON.stringify(value)
}

/**
 * The detail as lines of key and value, nested objects flattened into
 * `statuses 2xx`. Plain strings, for text nodes: whatever a component wrote,
 * the page never interprets it as markup.
 */
export function detailLines(detail: Record<string, unknown> | null, prefix = ""): DetailLine[] {
  if (detail === null) return []
  return Object.entries(detail).flatMap(([key, value]) => {
    const name = prefix === "" ? keyWords(key) : `${prefix} ${keyWords(key)}`
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = detailLines(value as Record<string, unknown>, name)
      return inner.length === 0 ? [{ key: name, value: "none" }] : inner
    }
    return [{ key: name, value: valueText(value) }]
  })
}

// --- The exports -----------------------------------------------------------------

export const CSV_COLUMNS = ["at", "source", "actor", "action", "target", "site", "detail"] as const

/**
 * One CSV field. Quoted when it must be, and a value a spreadsheet would read
 * as a formula (`=`, `+`, `-`, `@`, a tab or a carriage return first) starts
 * with an apostrophe: an actor or a target can come from a stranger, the email
 * of a refused sign-in for instance, and must stay text once opened.
 */
export function csvField(value: string | null): string {
  if (value === null) return ""
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The rows as CSV, one line per row, the detail as its JSON. */
export function toCsv(rows: readonly AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(",")]
  for (const row of rows) {
    lines.push(
      [row.at, row.source, row.actor, row.action, row.target, row.site, row.detail === null ? null : JSON.stringify(row.detail)]
        .map((value) => csvField(value))
        .join(","),
    )
  }
  return `${lines.join("\r\n")}\r\n`
}

/** The rows as JSON lines, one object per line, in the shape the server sent. */
export function toJsonLines(rows: readonly AuditRow[]): string {
  return rows.map((row) => JSON.stringify({ at: row.at, source: row.source, actor: row.actor, action: row.action, target: row.target, site: row.site, detail: row.detail, id: row.id })).join("\n") + (rows.length === 0 ? "" : "\n")
}

/** `sitesolide-activity-2026-10-04-1405.csv`, in the browser's time zone. */
export function exportName(extension: "csv" | "jsonl", now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0")
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  return `sitesolide-activity-${day}-${two(now.getHours())}${two(now.getMinutes())}.${extension}`
}
