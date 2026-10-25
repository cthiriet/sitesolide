/**
 * What the Connectors page decides: its calls, the state of each grant and
 * what waits for a decision, the words of the egress proxy's activity, and
 * which field a refusal belongs to.
 * Pure apart from the calls, tested by tests/connectors.test.ts.
 *
 * The page judges no rule on a connector: it sends, and shows the steward's
 * refusal under the field it names. A connector's value is sent once, in the
 * body of a write, and never comes back.
 */
import { callApi, send, type SecretsRefusal } from "./api"
import { capitalise } from "./format"
import type { Tone } from "./tones"
import type {
  ConnectorsActivityResponse,
  ConnectorsView,
  DashboardConnectorsResponse,
  EgressAuditRow,
} from "./types"

// --- The calls -------------------------------------------------------------------

export function readConnectors() {
  return callApi<DashboardConnectorsResponse & SecretsRefusal>("/api/connectors")
}

export function readConnectorsActivity() {
  return callApi<ConnectorsActivityResponse & SecretsRefusal>("/api/connectors/activity")
}

/** `value` null keeps the one in place. The body is rebuilt key by key: the steward refuses any other field. */
export function putConnector({ name, baseUrl, header, value }: { name: string; baseUrl: string; header: string; value: string | null }) {
  return send<ConnectorsView & SecretsRefusal>("PUT", "/api/connectors/connector", { name, baseUrl, header, value })
}

export function removeConnector({ name, confirmation }: { name: string; confirmation: string }) {
  return send<ConnectorsView & SecretsRefusal>("DELETE", "/api/connectors/connector", { name, confirmation })
}

export function setGrant({ slug, connector, granted }: { slug: string; connector: string; granted: boolean }) {
  return send<ConnectorsView & SecretsRefusal>("PUT", "/api/connectors/grant", { slug, connector, granted })
}

// --- The grants ------------------------------------------------------------------

/**
 * `granted`: asked for and granted, the connector works.
 * `asked`: the manifest asks, nobody granted it yet.
 * `missing`: the manifest asks for a connector this server does not have.
 * `unasked`: granted, but the manifest does not ask: it lends nothing until it does.
 * `gone`: granted to a site that is no longer deployed, to withdraw before the slug is reused.
 */
export type GrantState = "granted" | "asked" | "missing" | "unasked" | "gone"

export type GrantRow = { slug: string; connector: string; state: GrantState; at: string | null }

const ORDER: Record<GrantState, number> = { gone: 0, asked: 1, missing: 2, granted: 3, unasked: 4 }

/** Every pair that matters, what needs a decision first, then by connector and site. */
export function grantRows(view: Pick<ConnectorsView, "connectors" | "grants" | "requests" | "sites">): GrantRow[] {
  const defined = new Set(view.connectors.map((connector) => connector.name))
  const sites = new Set(view.sites)
  const grantedAt = new Map(view.grants.map((grant) => [`${grant.slug}/${grant.connector}`, grant.at]))
  const rows: GrantRow[] = []
  const seen = new Set<string>()

  for (const request of view.requests) {
    for (const connector of request.connectors) {
      const key = `${request.slug}/${connector}`
      seen.add(key)
      const at = grantedAt.get(key) ?? null
      const state: GrantState = at !== null ? "granted" : defined.has(connector) ? "asked" : "missing"
      rows.push({ slug: request.slug, connector, state, at })
    }
  }
  for (const grant of view.grants) {
    const key = `${grant.slug}/${grant.connector}`
    if (seen.has(key)) continue
    rows.push({ slug: grant.slug, connector: grant.connector, state: sites.has(grant.slug) ? "unasked" : "gone", at: grant.at })
  }
  return rows.sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || a.connector.localeCompare(b.connector, "en") || a.slug.localeCompare(b.slug, "en"),
  )
}

export type GrantWords = { word: string; tone: Tone; help: string; action: "grant" | "withdraw" | null }

export function grantWords(row: GrantRow): GrantWords {
  switch (row.state) {
    case "granted":
      return { word: "Granted", tone: "ok", help: `${row.slug} can call ${row.connector}.`, action: "withdraw" }
    case "asked":
      return { word: "Asked, not granted", tone: "attention", help: `${row.slug}'s sitesolide.json asks for ${row.connector}.`, action: "grant" }
    case "missing":
      return { word: "No such connector", tone: "attention", help: `${row.slug} asks for ${row.connector}, which this server doesn't have.`, action: null }
    case "unasked":
      return { word: "Not asked for", tone: "neutral", help: `Lends nothing until ${row.slug}'s sitesolide.json asks for ${row.connector}.`, action: "withdraw" }
    case "gone":
      return { word: "Site removed", tone: "error", help: `${row.slug} is no longer deployed. Withdraw it before the name is reused.`, action: "withdraw" }
  }
}

/** The states that wait for the owner: a removed site still granted, a request not granted, a connector the server lacks. */
const DECISIONS: ReadonlySet<GrantState> = new Set(["gone", "asked", "missing"])

/**
 * The Requests panel: what needs a decision, first on the page and only
 * while something waits. Its count is its rows'.
 */
export function requestRows(view: Pick<ConnectorsView, "connectors" | "grants" | "requests" | "sites">): GrantRow[] {
  return grantRows(view).filter((row) => DECISIONS.has(row.state))
}

/** A request's mark in the gutter: a grant left to a removed site is an error, a request waiting a warning. */
export function grantSeverity(state: GrantState): "error" | "warning" | null {
  if (state === "gone") return "error"
  return DECISIONS.has(state) ? "warning" : null
}

/**
 * The projects a connector is granted to, as its row lists them: the
 * deployed sites, each once, those that do not ask for it among them (it
 * lends them nothing until they do). A grant left to a removed site is a
 * request, not a project.
 */
export function grantedProjects(view: Pick<ConnectorsView, "connectors" | "grants" | "requests" | "sites">, name: string): GrantRow[] {
  return grantRows(view).filter((row) => row.connector === name && (row.state === "granted" || row.state === "unasked"))
}

/** Every pair that concerns one connector, for its sheet, what needs a decision first. */
export function connectorPairs(view: Pick<ConnectorsView, "connectors" | "grants" | "requests" | "sites">, name: string): GrantRow[] {
  return grantRows(view).filter((row) => row.connector === name && row.state !== "missing")
}

/** A base address as the row shows it: without its scheme or a trailing slash, "api.github.com/repos/example". */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

// --- The activity ----------------------------------------------------------------

function detailOf(row: EgressAuditRow): Record<string, unknown> {
  if (row.detail === null) return {}
  try {
    const parsed: unknown = JSON.parse(row.detail)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

export type ActivityLine = {
  /** What happened, in a sentence. */
  summary: string
  /** The site concerned, null when there is none. */
  site: string | null
  /** A second line: why, how many, by whom. */
  detail: string | null
  tone: Tone
  /** The milliseconds of `at`, null when it does not read. */
  at: number | null
}

const times = (n: number | null) => (n === null || n === 1 ? "" : `, ${n} times`)

/** A row of the proxy's audit in words. An action this page does not know yet is shown as it is. */
export function activityLine(row: EgressAuditRow): ActivityLine {
  const detail = detailOf(row)
  const parsedAt = Date.parse(row.at)
  const at = Number.isNaN(parsedAt) ? null : parsedAt
  switch (row.action) {
    case "egress.denied": {
      const destination = text(detail.destination)
      const reason = text(detail.reason) ?? "refused"
      if (reason === "rate limited") {
        return { summary: "More refusals than the audit keeps", site: null, detail: `${count(detail.count) ?? 0} refusals to ${count(detail.pairs) ?? 0} destinations not detailed`, tone: "attention", at }
      }
      const account = text(detail.account)
      return {
        summary: destination === null ? "Refused a connection" : `Refused ${destination.replace(/^connector:/, "connector ")}`,
        site: row.target,
        detail: `${reason}${times(count(detail.count))}${account === null ? "" : `, from the account ${account}`}`,
        tone: "attention",
        at,
      }
    }
    case "connector.use": {
      const failures = count(detail.failures) ?? 0
      return {
        summary: `Used ${text(detail.connector) ?? "a connector"}`,
        site: row.target,
        detail: `${count(detail.count) ?? 1} calls${failures > 0 ? `, ${failures} failed` : ""}`,
        tone: failures > 0 ? "attention" : "neutral",
        at,
      }
    }
    case "connector.update": {
      const change = text(detail.change)
      const name = row.target ?? "a connector"
      const summary = change === "created" ? `Added connector ${name}` : change === "removed" ? `Removed connector ${name}` : `Changed connector ${name}`
      const changed = Array.isArray(detail.changed) ? detail.changed.filter((field): field is string => typeof field === "string") : []
      const parts = [
        ...changed.map((field) => (field === "baseUrl" ? "base address" : field)),
        ...(detail.valueReplaced === true ? ["value replaced"] : []),
      ]
      return { summary, site: null, detail: [parts.join(", "), `by ${row.actor}`].filter((part) => part !== "").join(", "), tone: "neutral", at }
    }
    case "connector.grant": {
      const connector = text(detail.connector) ?? "a connector"
      const granted = detail.granted === true
      return {
        summary: granted ? `Granted ${connector}` : `Withdrew ${connector}`,
        site: row.target,
        detail: `by ${row.actor}`,
        tone: "neutral",
        at,
      }
    }
    default:
      return { summary: row.action, site: row.target, detail: null, tone: "neutral", at }
  }
}

/** The lines of the proxy's audit that concern one connector, for its sheet: its changes, its grants, its calls, the refusals to reach it. */
export function connectorRows(rows: readonly EgressAuditRow[], name: string): EgressAuditRow[] {
  return rows.filter((row) => {
    const detail = detailOf(row)
    if (row.action === "connector.update") return row.target === name
    if (row.action === "connector.use" || row.action === "connector.grant") return detail.connector === name
    if (row.action === "egress.denied") return detail.destination === `connector:${name}`
    return false
  })
}

// --- Refusals --------------------------------------------------------------------

export type ConnectorField = "name" | "baseUrl" | "header" | "value"

/**
 * The field a steward's refusal belongs to, read from the prefix of its
 * message (`base address: ...`), and the message without it. Anything else
 * belongs to the form as a whole.
 */
export function refusalField(message: string): { field: ConnectorField | null; message: string } {
  const prefixes: [string, ConnectorField][] = [
    ["name: ", "name"],
    ["base address: ", "baseUrl"],
    ["header: ", "header"],
    ["value: ", "value"],
  ]
  for (const [prefix, field] of prefixes) {
    if (message.startsWith(prefix)) {
      const rest = message.slice(prefix.length)
      return { field, message: capitalise(rest) }
    }
  }
  return { field: null, message }
}
