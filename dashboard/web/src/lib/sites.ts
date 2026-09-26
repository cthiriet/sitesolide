/**
 * What the site inventory decides, rather than the component: which address is
 * the main one, which door closes the site, what its service says, which sites
 * a filter keeps and in what order they are read. Pure, and therefore testable
 * without a browser.
 *
 * Nothing is judged anew here: the discrepancies come from `src/state.ts`, and
 * the memory thresholds from lib/gauges.ts.
 */
import { duration, size, sizeOutOf } from "./format"
import { serviceLevel, type Level } from "./gauges"
import type { Tone } from "./tones"
import type { Site } from "./types"
import type { Severity } from "./verdict"

export const TYPE_LABELS: Record<Site["type"], string> = {
  app: "App",
  static: "Static",
  "no-manifest": "No manifest",
}

// --- The address -----------------------------------------------------------------

export type Address = {
  href: string
  text: string
  /** The second line: the other address, or what is wrong with the domain. */
  note: { text: string; warn: boolean } | null
}

/**
 * The main link is the client's domain when it is active AND routed, the only
 * case where it really answers; otherwise the preview address, which always
 * answers.
 */
export function siteAddress(site: Pick<Site, "address" | "domain">): Address {
  const domain = site.domain
  const preversion = { href: `https://${site.address}`, text: site.address }
  if (domain === null) return { ...preversion, note: null }
  if (domain.active && domain.route) {
    return { href: `https://${domain.name}`, text: domain.name, note: { text: site.address, warn: false } }
  }
  if (domain.active) return { ...preversion, note: { text: `${domain.name} not routed`, warn: true } }
  if (domain.route) return { ...preversion, note: { text: `${domain.name} routed, not active`, warn: true } }
  return { ...preversion, note: { text: `Pending: ${domain.name}`, warn: false } }
}

// --- The door --------------------------------------------------------------------

/** The four possible disagreements between what the manifest asks for and what is running. */
export type Mismatch = "portal-absent" | "portal-extra" | "code-without-lock" | "lock-without-code"

export type Access =
  | { kind: "code"; code: string; url: string | null }
  | { kind: "portal"; exemptions: string[] }
  | { kind: "open" }
  | { kind: "mismatch"; key: Mismatch; label: string }

/**
 * How the site is closed, if it is. The two doors never coexist: the manifest
 * refuses "portal" and "lock" together. A disagreement between the manifest and
 * what is running comes before everything else, because it is what leaves a
 * site open when its owner believes it closed.
 */
export function siteAccess(site: Pick<Site, "portal" | "lock">): Access {
  const { wanted, installed, exemptions } = site.portal
  if (wanted && !installed) {
    return { kind: "mismatch", key: "portal-absent", label: "Portal not applied: served unprotected" }
  }
  if (!wanted && installed) {
    return { kind: "mismatch", key: "portal-extra", label: "Portal applied but not requested" }
  }
  if (wanted) return { kind: "portal", exemptions }

  const { closed, code, url } = site.lock
  if (!closed && code !== null) return { kind: "mismatch", key: "code-without-lock", label: "Code without lock" }
  if (closed && code === null) return { kind: "mismatch", key: "lock-without-code", label: "Lock has no code" }
  if (closed && code !== null) return { kind: "code", code, url }
  return { kind: "open" }
}

// --- The service -----------------------------------------------------------------

/** A service's word, and its tone: what the Service column and the site card say first. */
export type ServiceState = { tone: Tone; label: string }

/**
 * A systemd unit's word, the same on every page: Sites reads it in the
 * snapshot, Secrets in what the steward reports.
 *
 * Any service that is not active is an error, as in the discrepancies of
 * `src/state.ts`; the word only says in what way it is not running.
 * `auto-restart` is systemd restarting a service that went down, in a loop if
 * it goes down every time.
 */
export function serviceWord(active: string, subState: string): ServiceState {
  if (active === "active") return { tone: "ok", label: "Running" }
  if (subState === "auto-restart") return { tone: "error", label: "Restarting" }
  if (active === "activating") return { tone: "error", label: "Starting" }
  if (active === "deactivating") return { tone: "error", label: "Stopping" }
  return { tone: "error", label: "Down" }
}

/** The word for a site's service: an app with no loaded unit is down, a static site has nothing to judge. */
export function serviceState(site: Pick<Site, "type" | "service">): ServiceState {
  const service = site.service
  if (service === null) {
    if (site.type === "static") return { tone: "neutral", label: "Static files" }
    if (site.type === "app") return { tone: "error", label: "Down" }
    return { tone: "neutral", label: "No manifest" }
  }
  return serviceWord(service.active, service.subState)
}

export type ServiceSummary =
  | { kind: "static" }
  | { kind: "none" }
  | { kind: "stopped"; state: string; restarts: string | null }
  | {
      kind: "active"
      /** "61 of 256 MB", or the memory alone with no ceiling. */
      memory: string
      /** Memory over ceiling, capped at one hundred for the bar. */
      percent: number | null
      level: Level
      /** "3% CPU", or null before the second measurement. */
      cpu: string | null
      /** "up 20h", or null with no start date. */
      since: string | null
      restarts: string | null
    }

/** A share of a core: "3%", and "<1%" rather than a zero that would read as a sleeping service. */
export function computeCpuShare(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

export function restartsLabel(count: number | null): string | null {
  if (!count) return null
  return `${count} restart${count > 1 ? "s" : ""}`
}

/** Memory over its ceiling, as a percentage capped at one hundred. Nothing without a known ceiling. */
export function memoryShare(memory: number | null, limit: number | null): number | null {
  if (memory === null || limit === null || limit <= 0) return null
  return Math.min(100, Math.round((memory / limit) * 100))
}

/**
 * A site's service, as the inventory row shows it: memory against the ceiling,
 * the CPU share of the last minute, the restarts. The site card shows more, see
 * lib/site-card.ts.
 */
export function serviceSummaryOf(site: Pick<Site, "type" | "service">, now: number): ServiceSummary {
  const service = site.service
  if (service === null) {
    if (site.type === "static") return { kind: "static" }
    if (site.type === "app") return { kind: "stopped", state: "not loaded", restarts: null }
    return { kind: "none" }
  }
  const restarts = restartsLabel(service.restarts)
  if (service.active !== "active") return { kind: "stopped", state: service.active, restarts }

  const { memory, peak, limit } = service
  return {
    kind: "active",
    memory: limit === null ? size(memory) : sizeOutOf(memory, limit),
    percent: memoryShare(memory, limit),
    level: serviceLevel(memory, peak, limit),
    cpu: service.cpuShare === null ? null : `${computeCpuShare(service.cpuShare)} CPU`,
    since: service.since === null ? null : `up ${duration(now - service.since)}`,
    restarts,
  }
}

// --- Filters and order -----------------------------------------------------------

export type SiteFilter = "all" | "issues" | "apps" | "static" | "portal"

/** The inventory's filters, in the order they are displayed. */
export const FILTERS: readonly { key: SiteFilter; label: string; description: string }[] = [
  { key: "all", label: "All", description: "All sites" },
  { key: "issues", label: "Issues", description: "Sites with an refusal" },
  { key: "apps", label: "Apps", description: "Apps, which run a service" },
  { key: "static", label: "Static", description: "Static sites, served as files" },
  { key: "portal", label: "Portal", description: "Sites behind the portal" },
]

/**
 * A site behind the portal is so on both sides, requested or applied: a
 * disagreement between the two is precisely what you come looking for under
 * this filter.
 */
export function inFilter(
  site: Pick<Site, "slug" | "type" | "portal">,
  filter: SiteFilter,
  worst: ReadonlyMap<string, Severity>,
): boolean {
  switch (filter) {
    case "all":
      return true
    case "issues":
      return worst.has(site.slug)
    case "apps":
      return site.type === "app"
    case "static":
      return site.type === "static"
    case "portal":
      return site.portal.wanted || site.portal.installed
  }
}

export function filterByKind<T extends Pick<Site, "slug" | "type" | "portal">>(
  sites: readonly T[],
  filter: SiteFilter,
  worst: ReadonlyMap<string, Severity>,
): T[] {
  return sites.filter((site) => inFilter(site, filter, worst))
}

/** The number of sites under each filter, for the chip that carries it. */
export function countFilters(
  sites: readonly Pick<Site, "slug" | "type" | "portal">[],
  worst: ReadonlyMap<string, Severity>,
): Record<SiteFilter, number> {
  const counts = { all: 0, issues: 0, apps: 0, static: 0, portal: 0 }
  for (const site of sites) {
    for (const { key } of FILTERS) if (inFilter(site, key, worst)) counts[key] += 1
  }
  return counts
}

/**
 * Errors first, then warnings, then the rest; by name inside each group. The
 * site to look at is at the top, and a name is always found in the same place
 * within its group.
 */
export function sortSites<T extends Pick<Site, "slug">>(sites: readonly T[], worst: ReadonlyMap<string, Severity>): T[] {
  const index = (site: T) => {
    const severity = worst.get(site.slug)
    return severity === "error" ? 0 : severity === "warning" ? 1 : 2
  }
  return [...sites].sort((a, b) => index(a) - index(b) || a.slug.localeCompare(b.slug))
}

// --- The click on a row ----------------------------------------------------------

export type RowClick = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * What a click on a site row does, outside its link.
 *
 * The name is a real link, the one for the keyboard and for screen readers. The
 * rest of the row follows the click in code rather than through a link stretched
 * over the whole row: a link laid on top would stop you selecting an address, a
 * path or a number. A click on an element that already acts (link, button,
 * field) belongs to it; a click that ends a text selection does not navigate.
 * Cmd, Ctrl and the middle button open the site in a new tab, as on a link;
 * Shift and Alt do nothing.
 */
export function rowClickOutcome(click: RowClick, interactive: boolean, selection: string): "page" | "tab" | null {
  if (click.defaultPrevented || interactive || selection !== "") return null
  if (click.button === 1) return "tab"
  if (click.button !== 0 || click.shiftKey || click.altKey) return null
  return click.metaKey || click.ctrlKey ? "tab" : "page"
}

/** The elements that keep their click to themselves, inside a clickable row. */
export const INTERACTIVE = "a, button, input, textarea, select, label, [role='button']"

// --- The caption -----------------------------------------------------------------

/** The table's caption, for screen readers: the order, the filter and the search. */
export function sitesCaption(filter: SiteFilter, query: string | null): string {
  const parts = ["Sites served by the server, issues first, then by name"]
  if (filter !== "all") {
    const label = FILTERS.find((candidate) => candidate.key === filter)?.label ?? filter
    parts.push(`filtered by ${label}`)
  }
  if (query !== null) parts.push(`matching "${query}"`)
  return parts.join(", ")
}
