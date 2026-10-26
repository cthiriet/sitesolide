/**
 * What the Sites list decides, rather than the component: which projects it
 * lists, what each facet keeps and counts, the order, and what a row says
 * when it has something to say. Pure, tested by tests/site-list.test.ts.
 *
 * One line per site, quiet when fine: a row says nothing of a healthy
 * project. Its words come from the server, each discrepancy's `label`
 * (`src/state.ts`), never from reading a message here; the machine's own
 * discrepancies, and those of a project that has no folder any more, have no
 * row and go above the list.
 */
import { capitalise } from "./format"
import { ACCESS_KEYS, KIND_WORDS, KINDS, accessKey, siteKind, type AccessKey, type Kind } from "./legend"
import { narrowList, type ListSpec, type ListState } from "./list-state"
import { correspond, queryWords } from "./search"
import { PENDING_LABEL, type SiteSecretsPanel } from "./secrets"
import { serviceLevel, type Level } from "./gauges"
import { memoryShare, processorShare, serviceSummaryOf, siteAccess, siteWeight } from "./sites"
import type { Tone } from "./tones"
import type { Discrepancy, Site } from "./types"
import { sortDiscrepancies, type Severity } from "./verdict"

/** A site, with what the secrets say of it once read: the names of its variables, a restart pending. */
export type ListedSite = Site & Partial<SiteSecretsPanel>

// --- The facets and the sort -----------------------------------------------------

/**
 * The Kind facet: a project's kind, then the platform's own projects, which
 * every other value leaves out while they need nothing of the owner.
 */
export type KindFacet = Kind | "platform"
export const KIND_FACETS: readonly KindFacet[] = [...KINDS, "platform"]

/** The facet item of the platform's own projects, and the tag beside their name. */
export const PLATFORM_FACET = "Platform"

export type SiteSort = "issues" | "name" | "deployed" | "cpu" | "memory" | "disk"

/** The orders, the default first, and their words in the Sort menu. */
export const SITE_SORTS: readonly { value: SiteSort; label: string }[] = [
  { value: "issues", label: "Issues first" },
  { value: "name", label: "Name" },
  { value: "deployed", label: "Last deployed" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  { value: "disk", label: "Disk" },
]

/** What the Sites list reads from its address: `?q=`, `?access=`, `?kind=`, `?sort=`. */
export const SITES_LIST: ListSpec = {
  facets: { access: ACCESS_KEYS, kind: KIND_FACETS },
  sorts: SITE_SORTS.map((sort) => sort.value),
}

/**
 * The two orders that bring a figure into the row, as its own column: CPU and
 * Disk. Memory has its column always, the one a site runs out of.
 */
export function figureOf(sort: string | null): "cpu" | "disk" | null {
  return sort === "cpu" || sort === "disk" ? sort : null
}

/**
 * A site's share of the processor past which its row names it beside its
 * name, "CPU 18%": nearly one core in six on a six-core machine. Below it a
 * site's CPU says nothing worth a glance, and the CPU sort ranks them all.
 */
export const BUSY_PROCESSOR_SHARE = 15

/** The share of the processor a row names, or null below BUSY_PROCESSOR_SHARE or with nothing measured. */
export function busyShare(site: ListedSite, cores: number | null): number | null {
  const cpu = siteWeight(site).cpuShare
  const share = cpu === null ? null : processorShare(cpu, cores)
  return share !== null && share >= BUSY_PROCESSOR_SHARE ? share : null
}

/**
 * The Memory column: what the running services hold, against their limit,
 * and the level of the service's own bounds, amber from a peak at 80 % of the
 * limit, red past 90 %. Null when nothing runs.
 */
export function memoryUsage(site: ListedSite): { memory: number; limit: number | null; share: number | null; level: Level } | null {
  const { counted, memory, peak, limit } = siteWeight(site)
  if (counted === 0 || memory === null) return null
  return { memory, limit, share: memoryShare(memory, limit), level: serviceLevel(memory, peak, limit) }
}

// --- What the list keeps ---------------------------------------------------------

/**
 * Listed outside Platform: every site of the owner's, and a project of the
 * platform's own only while it needs the owner: an issue, of either severity,
 * or a restart pending, which the secrets say and no discrepancy does. A
 * healthy portal is nothing the owner looks after; a broken one is exactly
 * what they must see, at the top of the list.
 */
export function listed(
  site: Pick<Site, "slug" | "platform"> & Partial<Pick<SiteSecretsPanel, "restartPending">>,
  worst: ReadonlyMap<string, Severity>,
): boolean {
  return !site.platform || worst.has(site.slug) || site.restartPending === true
}

/**
 * How a site opens, as its row shows it: nothing for a project that serves no
 * page, whose address answers only a line saying so, unless the manifest and
 * the running block disagree, which is an issue wherever it is.
 */
export function listedAccess(site: ListedSite): AccessKey | null {
  const key = accessKey(siteAccess(site))
  return site.headless && site.domain === null && key !== "mismatch" ? null : key
}

/** A site's value for each facet: its access, none when it serves no page, and its kind, Platform as well for one of the platform's own. */
export function facetValues(site: ListedSite): { access: readonly AccessKey[]; kind: readonly KindFacet[] } {
  const kind = siteKind(site)
  const access = listedAccess(site)
  return { access: access === null ? [] : [access], kind: site.platform ? [kind, "platform"] : [kind] }
}

export type Narrowed<T> = {
  /** The rows to draw, in the server's order: `sortSites` orders them. */
  rows: T[]
  /** Each facet value's count, under the search and the other facet. */
  counts: { access: Record<string, number>; kind: Record<string, number> }
  /** What the header counts: what the list holds with no search and no facet, or the platform's own under Platform. */
  total: number
  /** The values each facet offers: those some project has, and the one chosen. */
  offered: { access: AccessKey[]; kind: KindFacet[] }
  /** Under a search that finds nothing listed, how many of the platform's own projects it finds. */
  platformMatches: number
}

/**
 * The rows a search and the facets keep, with the counts their menus show.
 *
 * Every value but Platform draws from what the list holds with no facet,
 * the platform's own projects there only while they need the owner; so a
 * facet's count never exceeds the header's. Platform draws from every one of
 * them, healthy or not, and counts them all.
 */
export function narrowSites<T extends ListedSite>(sites: readonly T[], worst: ReadonlyMap<string, Severity>, state: ListState): Narrowed<T> {
  const words = queryWords(state.query)
  const matchers = {
    search: (site: T) => correspond(site, words),
    facets: { access: (site: T) => facetValues(site).access, kind: (site: T) => facetValues(site).kind },
  }
  const shown = sites.filter((site) => listed(site, worst))
  const listedRun = narrowList(shown, state, matchers)
  const everyRun = narrowList(sites, state, matchers)
  const platform = state.facets.kind === "platform"
  const run = platform ? everyRun : listedRun

  const present = { access: new Set<string>(), kind: new Set<string>() }
  for (const site of sites) {
    const values = facetValues(site)
    for (const access of values.access) present.access.add(access)
    for (const kind of values.kind) present.kind.add(kind)
  }
  const offer = <V extends string>(values: readonly V[], name: "access" | "kind") =>
    values.filter((value) => present[name].has(value) || state.facets[name] === value)

  // A search that finds nothing the list holds, but some of the platform's own projects.
  const platformMatches =
    !platform && words.length > 0 && listedRun.rows.length === 0 ? sites.filter((site) => site.platform && correspond(site, words)).length : 0

  return {
    rows: run.rows,
    counts: {
      access: run.counts.access ?? {},
      kind: { ...(listedRun.counts.kind ?? {}), platform: everyRun.counts.kind?.platform ?? 0 },
    },
    total: platform ? sites.filter((site) => site.platform).length : shown.length,
    offered: { access: offer(ACCESS_KEYS, "access"), kind: offer(KIND_FACETS, "kind") },
    platformMatches,
  }
}

/**
 * Is the list narrowed, for "3 of 14"? A search, an access, a kind; not
 * Platform alone, which lists a set of its own that the header then counts.
 */
export function narrowedSites(state: ListState): boolean {
  const { access, kind } = state.facets
  return state.query.trim() !== "" || (access ?? null) !== null || (kind !== null && kind !== undefined && kind !== "platform")
}

// --- What a row says -------------------------------------------------------------

/**
 * A row's state: nothing for a fine one. Otherwise its first issue's label,
 * errors first, in its tone, with how many more there are, and every message
 * whole for its tooltip; or, with no issue, a restart pending, which no
 * discrepancy says. A restart pending is a change waiting for its owner,
 * not a fault the server found: it takes the attention tone and its word, but
 * not the gutter, which counts what the verdict and the sidebar count.
 */
export type RowState = {
  /** The gutter's icon: the worst issue's severity, null for a restart pending alone. */
  severity: Severity | null
  tone: Tone
  label: string
  /** The issues beyond the first, the "+2". */
  more: number
  /** Every issue's message, then the restart pending, for the tooltip and screen readers. */
  lines: string[]
}

export const PENDING_LINE = "Restart pending: a secret changed after the service last started"

export function rowState(
  site: Pick<Site, "slug"> & Partial<Pick<SiteSecretsPanel, "restartPending">>,
  discrepancies: readonly Discrepancy[],
): RowState | null {
  const issues = sortDiscrepancies(discrepancies.filter((discrepancy) => discrepancy.slug === site.slug))
  const pending = site.restartPending === true
  const first = issues[0]
  if (first === undefined) {
    if (!pending) return null
    return { severity: null, tone: "attention", label: PENDING_LABEL, more: 0, lines: [PENDING_LINE] }
  }
  return {
    severity: first.severity,
    tone: first.severity === "error" ? "error" : "attention",
    label: first.label,
    more: issues.length - 1,
    lines: [...issues.map((issue) => issue.message), ...(pending ? [PENDING_LINE] : [])],
  }
}

/**
 * The discrepancies no row carries: the machine's own, and those of a
 * project the snapshot has no folder for, an orphaned Caddy fragment. They go
 * above the list, errors first.
 */
export function rowlessIssues(discrepancies: readonly Discrepancy[], sites: readonly Pick<Site, "slug">[]): Discrepancy[] {
  const known = new Set(sites.map((site) => site.slug))
  return sortDiscrepancies(discrepancies.filter((discrepancy) => discrepancy.slug === null || !known.has(discrepancy.slug)))
}

/** The banners shown before "Show N more". */
export const BANNERS_SHOWN = 2

// --- The order -------------------------------------------------------------------

/** A row's rank under Issues first: errors, warnings, a restart pending, then the rest. */
function issueRank(site: ListedSite, worst: ReadonlyMap<string, Severity>): number {
  const severity = worst.get(site.slug)
  if (severity === "error") return 0
  if (severity === "warning") return 1
  return site.restartPending === true ? 2 : 3
}

/** The figure a sort reads: the running services' CPU, in % of one core, what they hold, what the folder weighs. */
export function figure(site: ListedSite, which: "cpu" | "memory" | "disk"): number | null {
  if (which === "cpu") return siteWeight(site).cpuShare
  return which === "memory" ? siteWeight(site).memory : site.bytes
}

/**
 * The list's order. Issues first, by name inside each group: the site to look
 * at is on top, and a name is always found in the same place within its
 * group. Name alone. The newest deployment first. The heaviest first, in
 * CPU, memory or on disk, a project with no figure last. Ties go by name.
 */
export function sortSites<T extends ListedSite>(sites: readonly T[], sort: string | null, worst: ReadonlyMap<string, Severity>): T[] {
  const byName = (a: T, b: T) => a.slug.localeCompare(b.slug, "en")
  const descending = (pick: (site: T) => number | null) => (a: T, b: T) => {
    const x = pick(a)
    const y = pick(b)
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1
    return y - x || byName(a, b)
  }
  const order = (() => {
    switch (sort) {
      case "name":
        return byName
      case "deployed":
        return descending((site) => site.deployed)
      case "cpu":
        return descending((site) => figure(site, "cpu"))
      case "memory":
        return descending((site) => figure(site, "memory"))
      case "disk":
        return descending((site) => figure(site, "disk"))
      default:
        return (a: T, b: T) => issueRank(a, worst) - issueRank(b, worst) || byName(a, b)
    }
  })()
  return [...sites].sort(order)
}

/** The table's caption, for screen readers: the order, then what narrows the list. */
export function sitesCaption(sort: string | null, state: ListState): string {
  const order = SITE_SORTS.find((candidate) => candidate.value === sort)?.label ?? SITE_SORTS[0]!.label
  // An acronym keeps its capitals: "by CPU", "by last deployed".
  const words = order === order.toUpperCase() ? order : order.toLowerCase()
  const parts = [`Sites served by the server, ${order === "Issues first" ? "issues first, then by name" : `by ${words}`}`]
  const { access, kind } = state.facets
  if (access !== null && access !== undefined) parts.push(`access ${access}`)
  if (kind !== null && kind !== undefined) parts.push(kind === "platform" ? "the platform's own projects" : `kind ${kind}`)
  const query = state.query.trim().replace(/\s+/g, " ")
  if (query !== "") parts.push(`matching "${query}"`)
  return parts.join(", ")
}

// --- The kind's tooltip ----------------------------------------------------------

/**
 * What the kind icon's tooltip says beyond its word, when the row knows
 * more: how many services an app or a background project runs, when a
 * scheduled one runs next. Nothing otherwise, the kind's own sentence then.
 */
export function kindDetail(site: ListedSite, now: number): string | undefined {
  const kind = siteKind(site)
  const count = site.services.length
  if (kind === "scheduled") {
    const summary = serviceSummaryOf(site, now)
    return summary.kind === "active" && summary.next !== null ? `${KIND_WORDS.scheduled.description} ${capitalise(summary.next)}.` : undefined
  }
  if (count < 2) return undefined
  if (kind === "app") return `Serves pages through ${count} services.`
  if (kind === "background") return `Runs ${count} services in the background, serves no page.`
  return undefined
}
