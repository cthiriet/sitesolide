/**
 * The header's verdict: is the machine all right, in one word.
 *
 * Pure, drawn from the discrepancies `src/state.ts` has already judged: the
 * page re-evaluates nothing, it counts and names.
 */
import type { Discrepancy } from "./types"

export type Severity = Discrepancy["severity"]

export type VerdictTone = "ok" | "warning" | "error" | "stale"

export type Verdict = { tone: VerdictTone; label: string }

export function countBySeverity(discrepancies: readonly Discrepancy[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const discrepancy of discrepancies) {
    if (discrepancy.severity === "error") errors += 1
    else warnings += 1
  }
  return { errors, warnings }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/**
 * A stale snapshot wins over everything else: its discrepancies describe a
 * machine from several minutes ago, and "All clear" on an old photograph would
 * be the worst lie a dashboard could tell.
 */
export function verdict(discrepancies: readonly Discrepancy[], stale: boolean): Verdict {
  if (stale) return { tone: "stale", label: "Stale data" }
  const { errors, warnings } = countBySeverity(discrepancies)
  if (errors > 0) {
    const label =
      warnings > 0
        ? `${plural(errors, "error")} · ${plural(warnings, "warning")}`
        : plural(errors, "error")
    return { tone: "error", label }
  }
  if (warnings > 0) return { tone: "warning", label: plural(warnings, "warning") }
  return { tone: "ok", label: "All clear" }
}

/** With no readable snapshot there is nothing to judge, and that is said in red. */
export const NO_DATA: Verdict = { tone: "stale", label: "No data" }

/** Each site's worst severity. Site-less discrepancies, the machine's, do not enter. */
export function worstSeverities(discrepancies: readonly Discrepancy[]): Map<string, Severity> {
  const worst = new Map<string, Severity>()
  for (const discrepancy of discrepancies) {
    if (discrepancy.slug === null || worst.get(discrepancy.slug) === "error") continue
    worst.set(discrepancy.slug, discrepancy.severity)
  }
  return worst
}

/** Errors first; at equal severity, the server's order, `sort` being stable. */
export function sortDiscrepancies(discrepancies: readonly Discrepancy[]): Discrepancy[] {
  const index = (discrepancy: Discrepancy) => (discrepancy.severity === "error" ? 0 : 1)
  return [...discrepancies].sort((a, b) => index(a) - index(b))
}
