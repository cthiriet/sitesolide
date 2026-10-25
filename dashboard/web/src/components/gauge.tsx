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
 * One gauge of the strip: its label, its caption beside it once the cell has
 * room, its figure on the right in its level's colour, and the track under
 * them with its ticks at 70 and 90 %. `onPress` makes the whole cell the
 * button of a sort, Memory or Disk: the question the figure raises, which
 * site holds it, answered by the list below.
 */
function StripGauge({ tile, pressed, onPress }: { tile: Tile; pressed?: boolean; onPress?: () => void }) {
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="mono-label">{tile.heading}</span>
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground tabular-nums @lg/strip:inline">{tile.detail}</span>
        <span className={cn("ml-auto text-[0.9375rem] leading-5 font-medium tabular-nums", LEVEL_TEXT[tile.level])}>{tile.value}</span>
      </span>
      <Track tile={tile} />
    </>
  )
  const cell = "grid h-16 min-w-0 content-center gap-1.5 px-3 text-left @lg/strip:px-4"
  if (onPress === undefined) return <div className={cell}>{body}</div>
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={pressed ? `Sites sorted by ${tile.heading.toLowerCase()}` : `Sort sites by ${tile.heading.toLowerCase()}`}
      onClick={onPress}
      className={cn(
        cell,
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        pressed ? "bg-highlight" : "hover:bg-muted/45",
      )}
    >
      {body}
    </button>
  )
}

/**
 * The machine strip: a single VM serves every site, and what it runs short of
 * runs short for everyone, hence its place at the top of the home page. One
 * panel, 64 px, three gauges: load, memory and disk, the thresholds ticked on
 * each. The machine's size is in the captions ("1.3 on 6 cores", "5.7 of
 * 12 GB used"), its zone in the sidebar. Memory and Disk sort the list by
 * what each site holds, `sort` saying which is in force.
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
    <section aria-label="Server" className="@container/strip overflow-clip rounded-xl border bg-card text-card-foreground shadow-panel">
      <div className="grid grid-cols-3 divide-x">
        <StripGauge tile={loadTile(machine)} />
        <StripGauge tile={memoryTile(machine)} pressed={sort === "memory"} onPress={() => onSort("memory")} />
        <StripGauge tile={diskTile(machine)} pressed={sort === "disk"} onPress={() => onSort("disk")} />
      </div>
    </section>
  )
}

export function StripSkeleton() {
  return (
    <div aria-hidden="true" className="grid h-[4.125rem] grid-cols-3 divide-x rounded-xl border bg-card shadow-panel">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="grid content-center gap-2.5 px-4">
          <div className="flex justify-between">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3.5 w-8" />
          </div>
          <Skeleton className="h-1.5 w-full" />
        </div>
      ))}
    </div>
  )
}
