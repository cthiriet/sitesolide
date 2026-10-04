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
import { operationOutcome, operationParts } from "./secrets"
import type { Tone } from "./tones"
import type { AuditResponse, AuditRow, AuditSource, LogEntry, Operation, SourceStatus } from "./types"

// --- The sources -----------------------------------------------------------------

export type SourceEntry = { key: AuditSource; label: string; description: string }

/** In the order the server lists them. */
export const SOURCES: readonly SourceEntry[] = [
  { key: "dashboard", label: "Dashboard", description: "Team tokens, and the deployments they make" },
  { key: "portal", label: "Portal", description: "Sign-ins, sign-outs and who gets in" },
  { key: "egress", label: "Egress", description: "Refused destinations, connector calls and changes" },
  { key: "backups", label: "Backups", description: "Scheduled runs and restores" },
  { key: "steward", label: "Steward", description: "Secrets, portal doors and restarts" },
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
  "unmanaged-account": "not a work account",
  "unverified-email": "email not verified",
  "no-email": "no email shared",
  "unusable-email": "unusable email",
  "provider-error": "cancelled or refused by the provider",
  "provider-unreachable": "provider unreachable",
  "not-shared": "site not shared with them",
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

/** The steward's operation behind an action, for the words its own Activity always used. */
const STEWARD_OPERATIONS: Readonly<Record<string, Operation>> = {
  "secrets.unlock": "unlock",
  "secrets.lock": "lock",
  "secrets.read": "read",
  "secrets.set": "set",
  "secrets.remove": "remove",
  "secrets.create": "create",
  "secrets.restore": "restore",
  "secrets.replace": "replace",
  "secrets.password": "password",
  "door.update": "portal",
  "service.restart": "restart",
}

const DONE: Readonly<Record<Operation, string>> = {
  unlock: "Unlocked the secrets",
  lock: "Locked the secrets",
  read: "Read",
  set: "Set",
  remove: "Removed",
  create: "Created",
  restore: "Restored the previous",
  replace: "Replaced",
  password: "Changed",
  portal: "Changed the portal",
  restart: "Restarted",
}

const TRIED: Readonly<Record<Operation, string>> = {
  unlock: "Tried to unlock the secrets",
  lock: "Tried to lock the secrets",
  read: "Tried to read",
  set: "Tried to set",
  remove: "Tried to remove",
  create: "Tried to create",
  restore: "Tried to restore the previous",
  replace: "Tried to replace",
  password: "Tried to change",
  portal: "Tried to change the portal",
  restart: "Tried to restart",
}

function stewardWords(row: AuditRow, operation: Operation): AuditWords {
  const detail = row.detail ?? {}
  const result = text(detail.result)
  const entry: LogEntry = {
    a: Date.parse(row.at),
    operation,
    result: result === "rejects" || result === "failure" ? result : "ok",
    slug: row.target,
    file: text(detail.file),
    variable: text(detail.variable),
    detail: text(detail.note),
  }
  const outcome = operationOutcome(entry)
  const ok = entry.result === "ok"
  const tone: Tone = outcome.tone === "ok" ? "neutral" : outcome.tone
  if (operation === "portal") {
    // The journal writes the door's direction first: "on, ok", "off, failure".
    const direction = entry.detail?.split(",")[0]?.trim()
    const door = direction === "on" ? "on" : direction === "off" ? "off" : null
    const summary = door === null ? (ok ? DONE.portal : TRIED.portal) : `${ok ? "Turned" : "Tried to turn"} ${door} the portal`
    return { summary, note: ok ? null : entry.result === "rejects" ? "Refused" : "Failed", tone }
  }
  const { object, kind } = operationParts(entry)
  // A site already shows in its own column.
  const named = object !== null && kind !== "project" ? ` ${object}` : ""
  return { summary: `${ok ? DONE[operation] : TRIED[operation]}${named}`, note: outcome.text, tone }
}

/**
 * A row in words. An action this page does not know yet is shown as it is,
 * its detail below: a component updated before the page loses nothing.
 */
export function auditWords(row: AuditRow): AuditWords {
  const detail = row.detail ?? {}
  if (Object.hasOwn(STEWARD_OPERATIONS, row.action) && row.source === "steward") return stewardWords(row, STEWARD_OPERATIONS[row.action]!)

  switch (row.action) {
    case "token.create":
    case "token.revoke": {
      const label = text(detail.label)
      const holder = `${text(detail.email) ?? "someone"}${label === null ? "" : ` (${label})`}`
      return { summary: row.action === "token.create" ? `Created a token for ${holder}` : `Revoked the token of ${holder}`, note: null, tone: "neutral" }
    }
    case "deploy.start":
      return { summary: detail.creating === true ? "Started deploying a new project" : "Started a deployment", note: null, tone: "neutral" }
    case "deploy.success":
      return { summary: detail.creating === true ? "Deployed a new project" : "Deployed", note: null, tone: "neutral" }
    case "deploy.failure":
      return { summary: "Deployment failed", note: text(detail.error), tone: "error" }

    case "portal.signin": {
      const method = text(detail.method)
      const how = method === "password" ? "with the shared password" : method === "guest" ? "with a guest password" : method === "oidc" ? "with a work account" : null
      const role = text(detail.role)
      const summary = `Signed in${how === null ? "" : ` ${how}`}${role === null ? "" : `, as ${role}`}`
      return { summary, note: times(count(detail.count)), tone: "neutral" }
    }
    case "portal.signin_failed": {
      const reason = word(SIGNIN_REFUSALS, text(detail.reason)) ?? (text(detail.method) === "password" ? "wrong password" : null)
      return { summary: "Sign-in refused", note: reason, tone: "attention" }
    }
    case "portal.signout":
      return { summary: "Signed out", note: times(count(detail.count)), tone: "neutral" }
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
      const summary = mode !== null && mode !== previous ? `Changed who gets in to ${word(SHARING_MODES, mode)}` : "Changed who gets in"
      return { summary, note: note === "" ? null : note, tone: "neutral" }
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

/** Who acted. A token says whose it is when the row knows. */
export function actorLabel(row: AuditRow): string {
  const email = text(row.detail?.email)
  if (row.actor.startsWith("token:") && email !== null) return `${email} (${row.actor})`
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
