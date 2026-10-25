/**
 * What the site inventory decides, rather than the component: which address is
 * the main one, how the site opens, what its service says, which sites
 * a filter keeps and in what order they are read. Pure, and therefore testable
 * without a browser.
 *
 * Nothing is judged anew here: the discrepancies come from `src/state.ts`, and
 * the memory thresholds from lib/gauges.ts.
 */
import { ago, duration, fromNow, size, sizeOutOf } from "./format"
import { serviceLevel, type Level } from "./gauges"
import type { Click } from "./pages"
import type { SiteSecretsPanel } from "./secrets"
import type { Tone } from "./tones"
import type { Site, SiteService } from "./types"
import type { Severity } from "./verdict"

export const TYPE_LABELS: Record<Site["type"], string> = {
  app: "App",
  static: "Static",
  "no-manifest": "No manifest",
}

/** The tag beside the name of one of the platform's own projects, the word of its filter. */
export const PLATFORM_TAG = "Platform"

// --- The address -----------------------------------------------------------------

export type Address = {
  href: string
  text: string
  /** The second line: the other address, or what is wrong with the domain. */
  note: { text: string; warn: boolean } | null
}

/** What the address of a project that serves no page answers, said beside it. */
export const HEADLESS_NOTE = "Runs in the background, serves no page"

/**
 * The main link is the client's domain when it is active AND routed, the only
 * case where it really answers; otherwise the preview address, which always
 * answers. A project that serves no page has no domain, the manifest refuses
 * one: its address answers a line saying so, and the note says it first.
 */
export function siteAddress(site: Pick<Site, "address" | "domain" | "headless">): Address {
  const domain = site.domain
  const preview = { href: `https://${site.address}`, text: site.address }
  if (site.headless && domain === null) return { ...preview, note: { text: HEADLESS_NOTE, warn: false } }
  if (domain === null) return { ...preview, note: null }
  if (domain.active && domain.route) {
    return { href: `https://${domain.name}`, text: domain.name, note: { text: site.address, warn: false } }
  }
  if (domain.active) return { ...preview, note: { text: `${domain.name} not routed`, warn: true } }
  if (domain.route) return { ...preview, note: { text: `${domain.name} routed, not active`, warn: true } }
  return { ...preview, note: { text: `Pending: ${domain.name}`, warn: false } }
}

// --- General access ------------------------------------------------------------------

/** The four possible disagreements between what the manifest asks for and what is running. */
export type Mismatch = "portal-absent" | "portal-extra" | "code-without-lock" | "lock-without-code"

export type Access =
  /** `code` null: one is in force, withheld from whoever reads, a Viewer or a Developer. */
  | { kind: "code"; code: string | null; url: string | null }
  | { kind: "portal"; exemptions: string[] }
  | { kind: "open" }
  | { kind: "mismatch"; key: Mismatch; label: string }

/**
 * How the site opens. A code and a restriction never coexist: the manifest
 * refuses "portal" and "lock" together. A disagreement between the manifest and
 * what is running comes before everything else, because it is what leaves a
 * site open when its owner believes it closed.
 */
export function siteAccess(site: Pick<Site, "portal" | "lock">): Access {
  const { wanted, installed, exemptions } = site.portal
  if (wanted && !installed) {
    return { kind: "mismatch", key: "portal-absent", label: "Restricted in sitesolide.json, public on the server" }
  }
  if (!wanted && installed) {
    return { kind: "mismatch", key: "portal-extra", label: "Restricted on the server, public in sitesolide.json" }
  }
  if (wanted) return { kind: "portal", exemptions }

  const { closed, code, url } = site.lock
  // A code in force the snapshot does not show this reader: the site opens
  // with one, and an Admin of it holds it.
  if (closed && code === null && site.lock.withheld === true) return { kind: "code", code: null, url: null }
  if (!closed && code !== null) return { kind: "mismatch", key: "code-without-lock", label: "A code on the server, none in sitesolide.json" }
  if (closed && code === null) return { kind: "mismatch", key: "lock-without-code", label: "A code in sitesolide.json, none on the server" }
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
 *
 * `active (exited)` is the anchor's state, the main unit of a project whose
 * every service is scheduled (isAnchored in bin/cli/manifest.ts): a oneshot
 * that runs nothing and stays active to keep their timers armed. No other
 * unit of a project exits and stays active, so the word says what the
 * project does, Scheduled, on Secrets as on its row.
 */
export function serviceWord(active: string, subState: string): ServiceState {
  if (active === "active") return subState === "exited" ? { tone: "ok", label: "Scheduled" } : { tone: "ok", label: "Running" }
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

// --- Workers and scheduled services ------------------------------------------------

/**
 * Is every service of the project scheduled? Its main unit is then an anchor,
 * which runs nothing, and none of its services is the main one.
 */
export function isAnchoredSite(site: Pick<Site, "services">): boolean {
  return site.services.length > 0 && site.services.every((entry) => !entry.main)
}

/** systemd's shorthands for a calendar expression, which read as words. */
const SCHEDULE_SHORTHANDS = new Set(["minutely", "hourly", "daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "annually"])

/**
 * "Runs hourly" for one of systemd's shorthands; null for any other
 * expression, `*:0/15` or `Mon..Fri 08:00`, which the page shows as written
 * rather than translate it into words that might say something else.
 */
export function scheduleWords(expression: string): string | null {
  const word = expression.trim().toLowerCase()
  return SCHEDULE_SHORTHANDS.has(word) ? `Runs ${word}` : null
}

/** A unit in one of these states is running a program, about to, or about to stop. */
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"])

/**
 * A scheduled service's word and tone. Inactive between two runs is its
 * normal state, Waiting, never Down; what puts it in error is its timer, not
 * active, since nothing runs any more. A failed last run is a warning, as in
 * the discrepancies of `src/state.ts`: the next run may go well.
 */
export function scheduledWord(entry: Pick<SiteService, "service" | "schedule">): ServiceState {
  const { service, schedule } = entry
  if (service === null) return { tone: "error", label: "Not loaded" }
  const timer = schedule?.timerState ?? null
  if (timer !== null && !timer.loaded) return { tone: "error", label: "No timer" }
  if (timer !== null && timer.active !== "active") return { tone: "error", label: "Schedule stopped" }
  if (RUNNING_STATES.has(service.active)) return { tone: "ok", label: "Running" }
  if (schedule?.lastRun?.ok === false) return { tone: "attention", label: "Last run failed" }
  return { tone: "ok", label: "Waiting" }
}

/** A line under a scheduled service's word, and its tone. */
export type RunLine = { text: string; tone: Tone }

/**
 * When a scheduled service last ran and how, and when it runs next: "Last
 * run 3h ago", "Failed 3h ago: exit code 1" under its word, which already
 * says it was the last run, "Started 2m ago" while it runs, "Next run in
 * 42m". After a reboot systemd no longer knows how the last run ended, only
 * when its timer started it. No next run while the timer is stopped: the
 * word already says it.
 */
export function runLines(entry: Pick<SiteService, "service" | "schedule">, now: number): { last: RunLine | null; next: string | null } {
  const { service, schedule } = entry
  if (schedule === null) return { last: null, next: null }
  const next = schedule.next === null ? null : schedule.next <= now ? "Next run due now" : `Next run ${fromNow(schedule.next - now)}`
  const run = schedule.lastRun
  let last: RunLine | null
  if (service !== null && RUNNING_STATES.has(service.active)) {
    last = service.since === null ? null : { text: `Started ${ago(now - service.since)}`, tone: "neutral" }
  } else if (run !== null && !run.ok) {
    const when = run.at === null ? "" : ` ${ago(now - run.at)}`
    last = { text: `Failed${when}: ${run.failure ?? "no reason given"}`, tone: "attention" }
  } else if (run !== null && run.at !== null) {
    last = { text: `Last run ${ago(now - run.at)}`, tone: "neutral" }
  } else {
    // Not the timer's last trigger: a persistent timer stamps the moment it
    // was first started, at a deployment, as a trigger that ran nothing.
    last = { text: "No run yet", tone: "neutral" }
  }
  return { last, next }
}

export type ServiceSummary =
  | { kind: "static" }
  | { kind: "none" }
  | { kind: "stopped"; state: string; restarts: string | null }
  | {
      kind: "active"
      /** "61 of 256 MB", or the memory alone with no ceiling; null while nothing of the project runs, between two scheduled runs. */
      memory: string | null
      /** Memory over ceiling, capped at one hundred for the bar. */
      percent: number | null
      level: Level
      /** "3% CPU", or null before the second measurement. */
      cpu: string | null
      /** "up 20h", or null with no start date. */
      since: string | null
      restarts: string | null
      /** "3 services" for a project running several, whose figures above are then their sum. */
      services: string | null
      /** "next run in 12m", for a project whose every service is scheduled: the soonest of their runs. */
      next: string | null
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
export function serviceSummaryOf(site: Pick<Site, "type" | "service"> & Partial<Pick<Site, "services">>, now: number): ServiceSummary {
  const service = site.service
  if (service === null) {
    if (site.type === "static") return { kind: "static" }
    if (site.type === "app") return { kind: "stopped", state: "not loaded", restarts: null }
    return { kind: "none" }
  }
  const restarts = restartsLabel(service.restarts)
  if (service.active !== "active") return { kind: "stopped", state: service.active, restarts }

  // A project of several services weighs what all of its running ones weigh:
  // the main one's figures alone would show a fraction of it. A figure one of
  // them lacks makes the sum unknown rather than wrong. A scheduled service
  // between two runs weighs nothing and holds no memory to measure, and the
  // anchor of a project whose every service is scheduled runs nothing:
  // neither is counted, rather than blank the sum for want of their figures.
  const entries = site.services ?? []
  const anchored = isAnchoredSite({ services: entries })
  const counted = [
    ...(anchored ? [] : [service]),
    ...entries
      .filter((entry) => !entry.main && (entry.kind !== "scheduled" || entry.service?.active === "active"))
      .map((entry) => entry.service),
  ]
  const sum = (pick: (entry: NonNullable<Site["service"]>) => number | null): number | null => {
    if (counted.length === 0) return null
    let total = 0
    for (const entry of counted) {
      const value = entry === null ? null : pick(entry)
      if (value === null) return null
      total += value
    }
    return total
  }
  const memory = sum((entry) => entry.memory)
  const peak = sum((entry) => entry.peak)
  const limit = sum((entry) => entry.limit)
  const cpuShare = sum((entry) => entry.cpuShare)
  const soonest = anchored
    ? entries.reduce<number | null>((first, entry) => {
        const next = entry.schedule?.next ?? null
        return next !== null && (first === null || next < first) ? next : first
      }, null)
    : null
  return {
    kind: "active",
    memory: counted.length === 0 ? null : limit === null ? size(memory) : sizeOutOf(memory, limit),
    percent: memoryShare(memory, limit),
    level: serviceLevel(memory, peak, limit),
    cpu: cpuShare === null ? null : `${computeCpuShare(cpuShare)} CPU`,
    since: service.since === null ? null : `up ${duration(now - service.since)}`,
    restarts,
    services: entries.length > 1 ? `${entries.length} services` : null,
    next: soonest === null ? null : soonest <= now ? "next run due now" : `next run ${fromNow(soonest - now)}`,
  }
}

// --- Filters and order -----------------------------------------------------------

export type SiteFilter = "all" | "issues" | "apps" | "static" | "restricted" | "platform"

/** The inventory's filters, in the order they are displayed. */
export const FILTERS: readonly { key: SiteFilter; label: string; description: string }[] = [
  { key: "all", label: "All", description: "Every site, and the platform's own projects while they need you" },
  { key: "issues", label: "Issues", description: "Sites with an issue" },
  { key: "apps", label: "Apps", description: "Apps, which run a service" },
  { key: "static", label: "Static", description: "Static sites, served as files" },
  { key: "restricted", label: "Restricted", description: "Sites only the people with access can open" },
  { key: "platform", label: PLATFORM_TAG, description: "Part of the platform: the dashboard, the portal and analytics" },
]

/** What a filter reads of a site: the snapshot's, and the restart pending the secrets say once read. */
type Filterable = Pick<Site, "slug" | "type" | "portal" | "platform"> & Partial<Pick<SiteSecretsPanel, "restartPending">>

/**
 * Listed outside Platform: every site of the owner's, and a project of the
 * platform's own only while it needs the owner: an issue, of either severity,
 * or a restart pending, which the secrets say and no discrepancy does. A
 * healthy portal is nothing the owner looks after; a broken one is exactly
 * what they must see, under All, where errors come first, and under Issues,
 * and one still running with a file it has not read yet waits for their
 * restart.
 */
export function listed(
  site: Pick<Site, "slug" | "platform"> & Partial<Pick<SiteSecretsPanel, "restartPending">>,
  worst: ReadonlyMap<string, Severity>,
): boolean {
  return !site.platform || worst.has(site.slug) || site.restartPending === true
}

/**
 * Every filter but Platform keeps a part of what All lists, so that its count
 * never exceeds All's. Platform keeps every project of the platform's own,
 * healthy or not, and nothing else.
 *
 * A site behind the portal is so on both sides, requested or applied: a
 * disagreement between the two is precisely what you come looking for under
 * Restricted.
 */
export function inFilter(site: Filterable, filter: SiteFilter, worst: ReadonlyMap<string, Severity>): boolean {
  if (filter === "platform") return site.platform
  if (!listed(site, worst)) return false
  switch (filter) {
    case "all":
      return true
    case "issues":
      return worst.has(site.slug)
    case "apps":
      return site.type === "app"
    case "static":
      return site.type === "static"
    case "restricted":
      return site.portal.wanted || site.portal.installed
  }
}

export function filterByKind<T extends Filterable>(
  sites: readonly T[],
  filter: SiteFilter,
  worst: ReadonlyMap<string, Severity>,
): T[] {
  return sites.filter((site) => inFilter(site, filter, worst))
}

/** The number of sites under each filter, for the chip that carries it. */
export function countFilters(
  sites: readonly Filterable[],
  worst: ReadonlyMap<string, Severity>,
): Record<SiteFilter, number> {
  const counts = { all: 0, issues: 0, apps: 0, static: 0, restricted: 0, platform: 0 }
  for (const site of sites) {
    for (const { key } of FILTERS) if (inFilter(site, key, worst)) counts[key] += 1
  }
  return counts
}

/**
 * The filters offered as chips: Platform only while the server carries one of
 * the platform's own projects, which a person's view never does. Decided
 * before the search: a chip does not come and go as a query is typed.
 */
export function offeredFilters(sites: readonly Pick<Site, "platform">[]): typeof FILTERS {
  const platform = sites.some((site) => site.platform)
  return FILTERS.filter((filter) => filter.key !== "platform" || platform)
}

/**
 * The filter in force: Platform falls back to All once the list carries none
 * of the platform's own projects, the chip being gone. The choice is
 * remembered for the page's session, and a person signed in in the owner's
 * place, without a reload, would otherwise inherit a Platform that names
 * nothing of theirs.
 */
export function effectiveFilter(chosen: SiteFilter, sites: readonly Pick<Site, "platform">[]): SiteFilter {
  return chosen === "platform" && !sites.some((site) => site.platform) ? "all" : chosen
}

/**
 * What the toolbar and the page header count, before the search: what All
 * lists under every filter but Platform, which counts its own. The figure
 * then agrees with the All chip, or with the Platform chip under Platform.
 */
export function inventoryTotal(
  sites: readonly Filterable[],
  filter: SiteFilter,
  worst: ReadonlyMap<string, Severity>,
): number {
  return filterByKind(sites, filter === "platform" ? "platform" : "all", worst).length
}

/** The projects of the platform's own that All leaves out: those that need nothing of the owner. */
export function hiddenPlatform(sites: readonly Filterable[], worst: ReadonlyMap<string, Severity>): number {
  return sites.filter((site) => site.platform && !listed(site, worst)).length
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
export function rowClickOutcome(click: Click, interactive: boolean, selection: string): "page" | "tab" | null {
  if (click.defaultPrevented || interactive || selection !== "") return null
  if (click.button === 1) return "tab"
  if (click.button !== 0 || click.shiftKey || click.altKey) return null
  return click.metaKey || click.ctrlKey ? "tab" : "page"
}

/** The elements that keep their click to themselves, inside a clickable row. */
export const INTERACTIVE = "a, button, input, textarea, select, label, [role='button']"

// --- The caption -----------------------------------------------------------------

/**
 * The table's caption, for screen readers: the order, the filter, the search,
 * and outside Platform how many of the platform's own projects are left out,
 * which the eye reads on the Platform chip.
 */
export function sitesCaption(filter: SiteFilter, query: string | null, hidden = 0): string {
  const parts = ["Sites served by the server, issues first, then by name"]
  if (filter !== "all") {
    const label = FILTERS.find((candidate) => candidate.key === filter)?.label ?? filter
    parts.push(`filtered by ${label}`)
  }
  if (query !== null) parts.push(`matching "${query}"`)
  if (filter !== "platform" && hidden > 0) {
    parts.push(`${hidden} platform ${hidden === 1 ? "project" : "projects"} left out, under Platform`)
  }
  return parts.join(", ")
}
