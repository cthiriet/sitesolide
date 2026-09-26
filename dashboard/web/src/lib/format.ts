/** Formatting of the reading's figures. Pure: returns text, decides nothing. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/**
 * What is shown in place of a value the reading did not get. A hyphen, as in
 * `sitesolide status`, and above all not an em dash: CLAUDE.md forbids it
 * everywhere, code included.
 */
export const ABSENT = "-"

/** Below this, an age reads "just now": "0s ago" or "-3s ago" say nothing more. */
export const JUST_NOW_MS = 5_000

/** The number and its unit, kept apart so a pair of sizes can share one. */
function decompose(bytes: number): { count: string; unit: string } {
  let value = bytes
  let index = 0
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024
    index += 1
  }
  const count = value < 10 && index > 0 ? value.toFixed(1) : String(Math.round(value))
  return { count, unit: UNITS[index] ?? "" }
}

export function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return ABSENT
  const { count, unit } = decompose(bytes)
  return `${count} ${unit}`
}

/**
 * A part and its whole, "1.9 of 3.8 GB". The unit is written once when both
 * share it, and twice otherwise: "900 MB of 3.8 GB".
 */
export function sizeOutOf(part: number | null, whole: number | null): string {
  if (part === null || whole === null) return ABSENT
  const a = decompose(part)
  const b = decompose(whole)
  if (a.unit === b.unit) return `${a.count} of ${b.count} ${b.unit}`
  return `${a.count} ${a.unit} of ${b.count} ${b.unit}`
}

/**
 * A compact duration: "30s", "5m", "2h", "13d". Hours run up to two days,
 * because "1d" for thirty-five hours would hide half a day.
 */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ABSENT
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * How long ago: "9d ago". A negative gap comes from two clocks out of tune, and
 * reads "just now" rather than a negative number.
 */
export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ABSENT
  if (ms < JUST_NOW_MS) return "just now"
  return `${duration(ms)} ago`
}

/** How long from now: "in 30d". */
export function fromNow(ms: number): string {
  return `in ${duration(ms)}`
}

/**
 * The snapshot's age at the instant `now`, in milliseconds.
 *
 * Computed from the age the server measured and the time the page received it,
 * rather than from `generated` and the browser's clock: a workstation a few
 * minutes fast or slow would otherwise throw off every display, whereas the
 * server reads the same clock as the collector. The time elapsed since
 * reception never goes backwards, even if the workstation's clock does.
 */
export function currentAge(age: number, receivedAt: number, now: number): number {
  return age + Math.max(0, now - receivedAt)
}

/**
 * A deadline, "Sep 22, 21:03". The time of day matters: a 24 hour access
 * created at 9 pm does not end at midnight. The time zone is a parameter for
 * the tests; the page takes the browser's.
 *
 * Assembled from the parts rather than through `format`: Bun's ICU writes
 * "Sep 22 at 21:03" where Chrome writes "Sep 22, 21:03", and the text copied
 * for a guest must not depend on the engine that produced it.
 */
export function dateTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timeZone,
  }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  return `${value("month")} ${value("day")}, ${value("hour")}:${value("minute")}`
}

/**
 * The label of a guest access duration, computed from the seconds.
 *
 * The portal supplies its own, `label`, but in French, and `portal/` is not
 * modified from this project. So the page starts from the seconds, the only
 * value the portal judges: a duration added to its menu gets a label without
 * coming through here.
 */
export function guestDuration(seconds: number | null): string {
  if (seconds === null) return "No expiry"
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`
  return `${Math.round(hours / 24)} days`
}
