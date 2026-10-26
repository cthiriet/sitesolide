import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  BAR_CLASSES,
  THRESHOLD_POSITIONS,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  loadTile,
  diskTile,
  memoryTile,
  type Level,
  type Tile,
} from "@/lib/gauges"
import type { Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The figure takes its bar's colour beyond the first threshold, on the plate as on a service's card. */
export const LEVEL_TEXT: Record<Level, string> = {
  normal: "",
  warn: "text-attention-text",
  critical: "text-destructive",
}

/**
 * A gauge's track, and the two thresholds engraved on it: a tick across the
 * bar at 70 and 90 %, standing out above and below it so that it still reads
 * where the fill covers it. At a glance you read the distance to the next
 * threshold, not only the colour of the moment.
 *
 * A site's card reuses it for a service's memory: its thresholds are then the
 * service's.
 */
export function Track({
  tile,
  thresholds = THRESHOLD_POSITIONS,
  title = `Warning from ${WARNING_THRESHOLD}%, critical from ${CRITICAL_THRESHOLD}%`,
}: {
  tile: Tile
  thresholds?: readonly { position: string }[]
  title?: string
}) {
  return (
    <div className="relative py-[3px]" title={title}>
      {/* The bar is capped at one hundred, the figure is not: a load of six on four cores reads 150 %. */}
      {tile.percent === null ? (
        <div className="h-1.5 w-full rounded-full bg-track shadow-well" />
      ) : (
        <Progress
          value={Math.min(tile.percent, 100)}
          aria-label={tile.heading}
          getAriaValueText={() => `${tile.value} used`}
          className={cn(
            "w-full [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-track",
            BAR_CLASSES[tile.level],
          )}
        />
      )}
      {thresholds.map(({ position }) => (
        <span
          key={position}
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-tick", position)}
        />
      ))}
    </div>
  )
}

/**
 * A service's memory over its ceiling, as a short bar beside its figure:
 * neutral, then in the colours of the service's thresholds. Nothing without a
 * known ceiling.
 */
export function MemoryBar({ percent, level, className }: { percent: number | null; level: Level; className?: string }) {
  if (percent === null) return null
  return (
    <Progress
      value={percent}
      aria-hidden="true"
      className={cn("w-12 shrink-0 [&_[data-slot=progress-track]]:h-1", BAR_CLASSES[level], className)}
    />
  )
}

/**
 * One readout of the strip: its label, a 56 px bar, its figure in its
 * level's colour and, once the line has 56 rem, the machine's size in muted
 * text: the three keep to one line rather than wrap.
 * `onPress` makes it the button of a sort, Memory or Disk: the question the
 * figure raises, which site holds it, answered by the list below.
 */
function StripReadout({ tile, pressed, onPress }: { tile: Tile; pressed?: boolean; onPress?: () => void }) {
  const body = (
    <>
      <span className="mono-label">{tile.heading}</span>
      <span
        className="relative h-1 w-14 shrink-0 overflow-hidden rounded-full bg-track"
        title={`Warning from ${WARNING_THRESHOLD}%, critical from ${CRITICAL_THRESHOLD}%`}
      >
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", READOUT_FILL[tile.level])}
          style={{ width: `${Math.min(tile.percent ?? 0, 100)}%` }}
        />
      </span>
      <span className={cn("text-sm font-medium tabular-nums", LEVEL_TEXT[tile.level])}>{tile.value}</span>
      <span className="hidden text-xs text-muted-foreground tabular-nums @4xl/strip:inline">{tile.detail}</span>
    </>
  )
  const cell = "-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2"
  if (onPress === undefined) return <div className={cell}>{body}</div>
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={pressed ? `Sites sorted by ${tile.heading.toLowerCase()}` : `Sort sites by ${tile.heading.toLowerCase()}`}
      onClick={onPress}
      className={cn(cell, "outline-none focus-visible:ring-2 focus-visible:ring-ring", pressed ? "bg-highlight" : "hover:bg-muted/45")}
    >
      {body}
    </button>
  )
}

const READOUT_FILL: Record<Level, string> = { normal: "bg-primary", warn: "bg-attention", critical: "bg-destructive" }

/**
 * The machine strip: a single VM serves every site, and what it runs short of
 * runs short for everyone, hence its place at the top of the home page. A
 * status line rather than a panel: load, memory and disk on one line, quiet
 * while they are fine, the figure and its bar amber or red past a
 * threshold; the alarm itself is the verdict's, which the monitor's
 * discrepancies raise. The machine's size is in the captions ("1.3 on 6
 * cores", "5.7 of 12 GB used"), its zone in the sidebar. Memory and Disk sort
 * the list by what each site holds, `sort` saying which is in force.
 */
export function MachineStrip({
  snapshot,
  sort,
  onSort,
}: {
  snapshot: Snapshot
  sort: string | null
  onSort: (sort: "memory" | "disk") => void
}) {
  const { machine } = snapshot
  return (
    <section aria-label="Server" className="@container/strip -my-1 flex flex-wrap items-center gap-x-8 gap-y-1">
      <StripReadout tile={loadTile(machine)} />
      <StripReadout tile={memoryTile(machine)} pressed={sort === "memory"} onPress={() => onSort("memory")} />
      <StripReadout tile={diskTile(machine)} pressed={sort === "disk"} onPress={() => onSort("disk")} />
    </section>
  )
}

export function StripSkeleton() {
  return (
    <div aria-hidden="true" className="-my-1 flex h-8 items-center gap-8">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center gap-2.5">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-1 w-14" />
          <Skeleton className="h-3.5 w-8" />
        </div>
      ))}
    </div>
  )
}
