/**
 * What the Audience section lays out: a site's figures, which are the
 * chart's tabs, the series each draws, and the rankings in their three
 * panels.
 *
 * The rates themselves are already computed by the service's `src/audience.ts`,
 * which draws them from the snapshot left by `analytics`. This module only
 * deals with layout: which rankings, under which titles, and in what order.
 *
 * Pure: takes figures, returns figures and strings.
 */
import type { DayCount, Row, Measure } from "./types"

/** One ranking: the snapshot's key, its English id for the address, its tab's word, what its rows name and what they count. */
export type RankingEntry = {
  /**
   * The snapshot's key. The snapshot names each ranking after its column in
   * analytics' database, a deployed one whose names stay French (see
   * CLAUDE.md): `hote` and not `host`, or the Hostnames tab would never find
   * its rows.
   */
  key: string
  /** The page's own name for it, English, in `?ranking=`. */
  id: string
  title: string
  /** What a row is, the column's head: "Page", "Source". */
  noun: string
  /** What its figure counts. */
  unit: "views" | "visits"
  /** Its values are machine strings, a path or a host, set in monospace. */
  machine: boolean
}

/** Three panels of rankings, each a question: what is read, where they come from, who they are. */
export type RankingGroup = { id: string; title: string; rankings: readonly RankingEntry[] }

/**
 * The rankings, in three tabbed panels, in the order they are read.
 *
 * The pages first, because that is what you come to see; the sources next,
 * because that is what gets decided; the visitors' hardware last, because
 * you only look at it once, the day you redo the layout.
 */
export const RANKING_GROUPS: readonly RankingGroup[] = [
  {
    id: "pages",
    title: "Pages",
    rankings: [
      { key: "chemin", id: "pages", title: "Pages", noun: "Page", unit: "views", machine: true },
      { key: "entree", id: "entry", title: "Entry pages", noun: "Page", unit: "visits", machine: true },
      { key: "hote", id: "hostnames", title: "Hostnames", noun: "Host", unit: "views", machine: true },
    ],
  },
  {
    id: "sources",
    title: "Sources",
    rankings: [
      { key: "source", id: "sources", title: "Sources", noun: "Source", unit: "visits", machine: false },
      { key: "campagne", id: "campaigns", title: "Campaigns", noun: "Campaign", unit: "visits", machine: false },
    ],
  },
  {
    id: "visitors",
    title: "Visitors",
    rankings: [
      { key: "appareil", id: "devices", title: "Devices", noun: "Device", unit: "visits", machine: false },
      { key: "navigateur", id: "browsers", title: "Browsers", noun: "Browser", unit: "visits", machine: false },
      { key: "systeme", id: "systems", title: "Systems", noun: "System", unit: "visits", machine: false },
      { key: "langue", id: "languages", title: "Languages", noun: "Language", unit: "visits", machine: false },
    ],
  },
]

/** Every ranking, flat, in the panels' order. */
export const RANKINGS: readonly RankingEntry[] = RANKING_GROUPS.flatMap((group) => group.rankings)

/** A ranking by its address's id; undefined for one the page does not know. */
export function rankingById(id: string | null): RankingEntry | undefined {
  return id === null ? undefined : RANKINGS.find((ranking) => ranking.id === id)
}

/** A panel shows its first rows; *Show all* opens the rest in a sheet. */
export const TOP_ROWS = 6

/** The rankings of a group that hold rows: a tab with nothing under it is not drawn. */
export function groupTabs(group: RankingGroup, rankings: Readonly<Record<string, readonly Row[]>>): RankingEntry[] {
  return group.rankings.filter((ranking) => (rankings[ranking.key] ?? []).length > 0)
}

/** The device families, as the database names them, in English here. */
const DEVICES: Readonly<Record<string, string>> = {
  mobile: "Mobile",
  tablette: "Tablet",
  bureau: "Desktop",
}

/**
 * A language's name, in the dashboard's language.
 *
 * `Intl.DisplayNames` carries the table, which every browser ships: copying it
 * here would grow stale, and there are close to two hundred languages. A code
 * the table does not know is returned as is, which beats a row with no name.
 */
const LANGUAGE_NAMES =
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "language", fallback: "none" })
    : null

export function rankingLabel(key: string, value: string): string {
  if (key === "appareil") return DEVICES[value] ?? value
  if (key !== "langue") return value
  try {
    return LANGUAGE_NAMES?.of(value) ?? value
  } catch {
    // A malformed code makes `of` throw: it comes from a web page.
    return value
  }
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US")

/** `12345` becomes `12,345`. */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value)
}

/** `126` becomes `2m 6s`, `45` stays `45s`, `0` becomes a hyphen. */
export function formatSeconds(value: number): string {
  if (value <= 0) return "-"
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  const remaining = value % 60
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`
}

/** `2026-09-21` becomes `Sep 21`, which fits under a tick. */
export function shortDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

/** What the chart can draw, one per tab. Time on page is kept for the period alone, never per day. */
export type Metric = "visits" | "views" | "pages"

/** The chart's head: four figures, three of them the tabs that switch the chart. */
export type Figure = {
  heading: string
  value: string
  /** What it counts, said in the tab's tooltip. */
  detail: string
  /** The series the tab draws; null for a figure the snapshot keeps no day of. */
  metric: Metric | null
}

export function figures(measure: Measure): Figure[] {
  return [
    { heading: "Visits", value: formatNumber(measure.visits), detail: "One visitor, one day", metric: "visits" },
    { heading: "Views", value: formatNumber(measure.views), detail: "Pages displayed", metric: "views" },
    {
      heading: "Pages per visit",
      value: measure.pagesPerVisit.toLocaleString("en-US"),
      detail: "How deep they read",
      metric: "pages",
    },
    {
      heading: "Time on page",
      value: formatSeconds(measure.timePerPage),
      detail: "Measured views only, over the whole period: the service keeps no daily figure for it",
      metric: null,
    },
  ]
}

/** A metric's words: its unit in the tooltip, singular and plural. */
export const METRIC_UNITS: Readonly<Record<Metric, { one: string; many: string }>> = {
  visits: { one: "visit", many: "visits" },
  views: { one: "view", many: "views" },
  pages: { one: "page per visit", many: "pages per visit" },
}

/**
 * A day's value for a metric. Pages per visit is the day's views over its
 * visits, to one decimal, and null on a day nobody came: zero would draw a
 * fall that never happened.
 */
export function dayValue(day: DayCount, metric: Metric): number | null {
  if (metric === "visits") return day.visits
  if (metric === "views") return day.views
  if (day.visits <= 0) return null
  return Math.round((day.views / day.visits) * 10) / 10
}

/** A value in a metric's own format: `1,148`, `2.1`. */
export function formatMetric(value: number, metric: Metric): string {
  return metric === "pages" ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : formatNumber(Math.round(value))
}

/** `2026-10-14` becomes `Tue, Oct 14`, the chart's tooltip. */
export function longDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}

/**
 * The axis ceiling, rounded to a step that reads well.
 *
 * An axis ending at 37 would force you to read its ticks one by one. The 1, 2,
 * 3, 5 sequence by powers of ten gives steps the eye recognises without
 * deciphering them, and halves that stay short: 3 halves to 1.5, where 2.5
 * would give 1.25. The 3 keeps pages per visit, about 2, off a chart that
 * would end at 5. A count, `whole`, under ten takes 2, 4, 6 or 10, whose
 * halves are counts too: an axis of visits never says 2.5.
 */
export function axisCeiling(maximum: number, whole = false): number {
  if (maximum <= 0) return whole ? 2 : 1
  const power = 10 ** Math.floor(Math.log10(maximum))
  const steps = whole && maximum < 10 ? [2, 4, 6, 10] : [1, 2, 3, 5, 10]
  for (const step of steps) {
    const candidate = step * (whole && maximum < 10 ? 1 : power)
    if (maximum <= candidate) return candidate
  }
  return 10 * power
}

/** True when the curve has not a single visit to show. */
export function emptyCurve(days: readonly DayCount[]): boolean {
  return days.every((day) => day.views === 0)
}

/** A row's share in its ranking, as a percentage of the first one. */
export function rowShare(line: Row, first: number): number {
  if (first <= 0) return 0
  return Math.max(2, Math.round((line.total / first) * 100))
}
