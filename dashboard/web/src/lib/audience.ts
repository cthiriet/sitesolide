/**
 * What the Audience section lays out: a site's figures, the curve, and the
 * rankings it shows.
 *
 * The rates themselves are already computed by the service's `src/audience.ts`,
 * which draws them from the snapshot left by `analytics`. This module only
 * deals with layout: which rankings, under which titles, and in what order.
 *
 * Pure: takes figures, returns figures and strings.
 */
import type { DayCount, Row, Measure } from "./types"

/**
 * The rankings shown, in the order they are read.
 *
 * The pages first, because that is what you come to see; the sources next,
 * because that is what gets decided; the hardware last, because you only look
 * at it once, the day you redo the layout.
 *
 * The key is the snapshot's, the unit says what the column counts in.
 */
export const RANKINGS: readonly { key: string; title: string; unit: string }[] = [
  { key: "chemin", title: "Pages", unit: "views" },
  { key: "entree", title: "Entry pages", unit: "visits" },
  { key: "source", title: "Sources", unit: "visits" },
  { key: "campagne", title: "Campaigns", unit: "visits" },
  { key: "appareil", title: "Devices", unit: "visits" },
  { key: "navigateur", title: "Browsers", unit: "visits" },
  { key: "systeme", title: "Systems", unit: "visits" },
  { key: "langue", title: "Languages", unit: "visits" },
  { key: "host", title: "Hostnames", unit: "views" },
]

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

/** The banner's four figures, in the order they are read. */
export type Figure = { heading: string; value: string; detail: string }

export function figures(measure: Measure): Figure[] {
  return [
    { heading: "Visits", value: formatNumber(measure.visits), detail: "one visitor, one day" },
    { heading: "Views", value: formatNumber(measure.views), detail: "pages displayed" },
    {
      heading: "Pages per visit",
      value: measure.pagesPerVisit.toLocaleString("en-US"),
      detail: "how deep they read",
    },
    { heading: "Time on page", value: formatSeconds(measure.timePerPage), detail: "measured views only" },
  ]
}

/**
 * The axis ceiling, rounded to a step that reads well.
 *
 * An axis ending at 37 would force you to read its ticks one by one. The 1, 2,
 * 5 sequence by powers of ten gives steps the eye recognises without
 * deciphering them.
 */
export function axisCeiling(maximum: number): number {
  if (maximum <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(maximum))
  for (const pas of [1, 2, 5, 10]) {
    const candidate = pas * power
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
