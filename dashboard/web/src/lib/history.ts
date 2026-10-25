/**
 * The Activity page's address, the one contract every History link speaks.
 * Pure, tested by tests/history.test.ts.
 *
 * A page does not show its own history: its header carries a quiet
 * *History* link to Activity, narrowed to that object, and a detail sheet
 * ends with *All activity* the same way. Six parameters, each optional:
 *
 *   /activity/?actor=token:&action=secrets.&target=cms&source=steward&type=secrets&since=7d
 *
 * - `actor`: part of the actor, any case (`owner`, `token:`, an email);
 * - `action`: the start of a dotted action (`access`, `deploy.success`);
 * - `target`: a site's slug or a host, its hosts included;
 * - `source`: one component's audit, `dashboard`, `portal`, `egress`, `backups`, `steward`;
 * - `type`: a family of actions, one of `HISTORY_TYPES`;
 * - `since`: `24h`, `7d`, `30d`, or a day, `2026-10-21`, in the reader's time zone.
 *
 * `actor`, `action`, `target` and `source` are what `/api/audit` takes as
 * they are. `type` and `since` are the page's: a type names several action
 * prefixes (`matchesType`), a since a start (`sinceStart`).
 */
import type { AuditSource } from "./types"

/** The families of actions Activity's Type facet offers, in its order. */
export type HistoryType = "deployments" | "access" | "secrets" | "signins" | "tokens" | "backups" | "egress"

export type HistoryTypeEntry = {
  key: HistoryType
  label: string
  /** The starts of the dotted actions it gathers, lowercase. */
  prefixes: readonly string[]
}

export const HISTORY_TYPES: readonly HistoryTypeEntry[] = [
  { key: "deployments", label: "Deployments", prefixes: ["deploy.", "project."] },
  // `access` alone covers access.add, .change, .code, .general and .remove;
  // the rest are the older rows from before one Access section.
  { key: "access", label: "Access changes", prefixes: ["access", "sharing.", "guest.", "member.invite", "member.role", "member.remove", "people."] },
  { key: "secrets", label: "Secrets", prefixes: ["secrets.", "service.restart"] },
  { key: "signins", label: "Sign-ins", prefixes: ["portal.sign", "dashboard.sign", "member.sign"] },
  { key: "tokens", label: "Tokens", prefixes: ["token."] },
  { key: "backups", label: "Backups", prefixes: ["backup."] },
  { key: "egress", label: "Egress", prefixes: ["egress.", "connector."] },
]

/** Does a row's dotted action belong to this family? */
export function matchesType(action: string, type: HistoryType): boolean {
  const entry = HISTORY_TYPES.find((candidate) => candidate.key === type)
  const lower = action.toLowerCase()
  return entry !== undefined && entry.prefixes.some((prefix) => lower.startsWith(prefix))
}

/** The ranges Activity's Date facet offers, a day typed in its custom range aside. */
export const SINCE_CHOICES = [
  { key: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 3_600_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 3_600_000 },
] as const

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A `since` that reads: one of the ranges, or a real day. */
function validSince(value: string): boolean {
  if (SINCE_CHOICES.some((choice) => choice.key === value)) return true
  const parts = DAY.exec(value)
  if (parts === null) return false
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return date.getFullYear() === Number(parts[1]) && date.getMonth() === Number(parts[2]) - 1 && date.getDate() === Number(parts[3])
}

/**
 * When a `since` starts, in milliseconds: `now` minus the range, or the
 * day's midnight in the reader's time zone. Null when it does not read.
 */
export function sinceStart(since: string, now: number): number | null {
  const range = SINCE_CHOICES.find((choice) => choice.key === since)
  if (range !== undefined) return now - range.ms
  if (!validSince(since)) return null
  const [year, month, day] = since.split("-").map(Number) as [number, number, number]
  return new Date(year, month - 1, day).getTime()
}

/** What a History link narrows Activity to. Every field is optional; an empty filter opens the whole log. */
export type HistoryFilter = {
  actor?: string
  action?: string
  target?: string
  source?: AuditSource
  type?: HistoryType
  since?: string
}

/** The order the parameters are written in, so that one filter always gives one address. */
const KEYS = ["actor", "action", "target", "source", "type", "since"] as const

const SOURCE_KEYS: readonly AuditSource[] = ["dashboard", "portal", "egress", "backups", "steward"]

/** Text fields are cut at the length the Activity page reads. */
const MAX_TEXT = 200

/** The Activity page's address, narrowed: what a History link opens. */
export function historyUrl(filter: HistoryFilter = {}): string {
  const query = new URLSearchParams()
  for (const key of KEYS) {
    const value = filter[key]?.trim() ?? ""
    if (value !== "") query.set(key, value)
  }
  const text = query.toString()
  return `/activity/${text === "" ? "" : `?${text}`}`
}

/**
 * The filter an address asks for. Text fields are kept as typed, cut to 200
 * characters; a source, a type or a since the page does not know is dropped
 * rather than shown as a filter that narrows nothing.
 */
export function readHistory(params: { get: (name: string) => string | null }): HistoryFilter {
  const filter: HistoryFilter = {}
  for (const key of ["actor", "action", "target"] as const) {
    const value = (params.get(key) ?? "").trim().slice(0, MAX_TEXT)
    if (value !== "") filter[key] = value
  }
  const source = params.get("source")
  if (source !== null && (SOURCE_KEYS as readonly string[]).includes(source)) filter.source = source as AuditSource
  const type = params.get("type")
  if (type !== null && HISTORY_TYPES.some((entry) => entry.key === type)) filter.type = type as HistoryType
  const since = params.get("since")?.trim() ?? ""
  if (since !== "" && validSince(since)) filter.since = since
  return filter
}

/** What a sheet's *Recent* reads: its object's last lines. */
export const RECENT_LINES = 10

/** A type of several prefixes is narrowed here, from this many rows read. */
const TYPE_WINDOW = 100

/**
 * The `/api/audit` query for a filter's latest rows, and what the page keeps
 * of them: the server takes `actor`, `action`, `target`, `source` and `from`
 * as they are; a type of one prefix goes as its `action`, a type of several
 * is narrowed here from a wider window, which may then return fewer lines.
 */
export function historyRequest(filter: HistoryFilter, now: number, limit = RECENT_LINES): { query: string; keep: (action: string) => boolean } {
  const query = new URLSearchParams()
  for (const key of ["source", "actor", "target"] as const) {
    const value = filter[key]?.trim() ?? ""
    if (value !== "") query.set(key, value)
  }
  const type = filter.type === undefined ? null : (HISTORY_TYPES.find((entry) => entry.key === filter.type) ?? null)
  const action = filter.action?.trim() ?? ""
  const single = type !== null && type.prefixes.length === 1 && action === ""
  if (action !== "") query.set("action", action)
  else if (single) query.set("action", type.prefixes[0]!)
  const start = filter.since === undefined ? null : sinceStart(filter.since, now)
  if (start !== null) query.set("from", new Date(start).toISOString())
  const narrowsHere = type !== null && !single
  query.set("limit", String(narrowsHere ? Math.max(limit, TYPE_WINDOW) : limit))
  return {
    query: `?${query}`,
    keep: narrowsHere ? (rowAction) => matchesType(rowAction, type.key) : () => true,
  }
}
