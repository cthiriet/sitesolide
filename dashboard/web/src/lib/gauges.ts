/**
 * The gauges: what they measure and when they change colour. Pure: the
 * components only read labels and classes from here.
 */
import { ABSENT, sizeOutOf } from "./format"
import type { RawMachine } from "./types"

/**
 * The two colour thresholds, and what they mean on this machine.
 *
 * A single VM serves every site, with no second machine and no automatic
 * failover: what runs short here runs short for everyone at once. The first
 * threshold is therefore an invitation to look, the second a figure to deal
 * with the same day.
 */
export const WARNING_THRESHOLD = 70
export const CRITICAL_THRESHOLD = 90

/**
 * For a service's memory, relative to its ceiling. The peak reuses the bound of
 * the discrepancy `src/state.ts` raises, WORRYING_PEAK_SHARE: the bar turns
 * amber exactly when the list of discrepancies reports it, which
 * tests/agreement-page.test.ts checks on the service side.
 */
export const PEAK_WARNING_SHARE = 0.8
export const MEMORY_CRITICAL_SHARE = 0.9

export type Level = "normal" | "warn" | "critical"

/**
 * Where the two thresholds sit on a gauge's track, which the machine plate
 * engraves. Spelled out in full, like every class Tailwind has to generate:
 * tests/gauges.test.ts checks that they follow the thresholds.
 */
export const THRESHOLD_POSITIONS: readonly { threshold: number; position: string }[] = [
  { threshold: WARNING_THRESHOLD, position: "left-[70%]" },
  { threshold: CRITICAL_THRESHOLD, position: "left-[90%]" },
]

/** The used share, from 0 to 100. A zero or unknown total returns nothing. */
export function usedShare(free: number | null, total: number | null): number | null {
  if (free === null || total === null || total <= 0) return null
  const used = Math.min(Math.max(total - free, 0), total)
  return Math.round((used / total) * 100)
}

/**
 * The share of capacity a load represents, as a percentage.
 *
 * A load is read against the number of cores and never in the absolute: three
 * is a quiet machine on eight cores and a saturated one on two. The figure is
 * not capped, the bar is.
 */
export function loadShare(loaded: number | null, cores: number | null): number | null {
  if (loaded === null || cores === null || cores <= 0) return null
  return Math.round((loaded / cores) * 100)
}

export function level(percent: number | null): Level {
  if (percent === null) return "normal"
  if (percent >= CRITICAL_THRESHOLD) return "critical"
  if (percent >= WARNING_THRESHOLD) return "warn"
  return "normal"
}

/**
 * The indicator's colour, set by a variant aimed at its `data-slot` rather than
 * by editing the component shadcn generated: a `shadcn add --overwrite` would
 * replace it without a word.
 *
 * Neutral below the first threshold: a green bar everywhere says nothing, and
 * colour thus stays reserved for what needs a look. The colours are the tone
 * tokens of styles/global.css, see lib/tones.ts.
 */
export const BAR_CLASSES: Record<Level, string> = {
  normal: "[&_[data-slot=progress-indicator]]:bg-foreground/55",
  warn: "[&_[data-slot=progress-indicator]]:bg-attention",
  critical: "[&_[data-slot=progress-indicator]]:bg-destructive",
}

/** A service's memory against its ceiling: the peak warns, the current level alarms. */
export function serviceLevel(memory: number | null, peak: number | null, limit: number | null): Level {
  if (limit === null || limit <= 0) return "normal"
  if (memory !== null && memory > limit * MEMORY_CRITICAL_SHARE) return "critical"
  if (peak !== null && peak >= limit * PEAK_WARNING_SHARE) return "warn"
  return "normal"
}

export type Tile = {
  heading: string
  /** The used percentage, for the bar, or null if nothing was collected. */
  percent: number | null
  value: string
  detail: string
  level: Level
}

const NOT_COLLECTED = "Not collected"

function usage(heading: string, free: number | null, total: number | null): Tile {
  const percent = usedShare(free, total)
  if (percent === null || free === null || total === null) {
    return { heading, percent: null, value: ABSENT, detail: NOT_COLLECTED, level: "normal" }
  }
  const used = Math.min(Math.max(total - free, 0), total)
  return {
    heading,
    percent,
    value: `${percent}%`,
    detail: `${sizeOutOf(used, total)} used`,
    level: level(percent),
  }
}

export function memoryTile(machine: RawMachine | null): Tile {
  return usage("Memory", machine?.memoryAvailable ?? null, machine?.memoryTotal ?? null)
}

export function diskTile(machine: RawMachine | null): Tile {
  return usage("Disk", machine?.diskFree ?? null, machine?.diskTotal ?? null)
}

/**
 * The one minute load, the one that moves fast enough for a refresh every
 * thirty seconds to mean something. The five minute one serves the
 * discrepancy, where a passing spike must not shout.
 */
export function loadTile(machine: RawMachine | null): Tile {
  const loaded = machine?.load1 ?? null
  const cores = machine?.cores ?? null
  const percent = loadShare(loaded, cores)
  if (percent === null) {
    return { heading: "Load", percent: null, value: ABSENT, detail: NOT_COLLECTED, level: "normal" }
  }
  return {
    heading: "Load",
    percent,
    value: `${percent}%`,
    detail: `${loaded} on ${cores} ${cores === 1 ? "core" : "cores"}`,
    level: level(percent),
  }
}
