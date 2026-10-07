import { useId } from "react"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ABSENT, size } from "@/lib/format"
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

/** The figure takes its bar's colour beyond the first threshold. */
const LEVEL_TEXT: Record<Level, string> = {
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
        <div className="h-1.5 w-full rounded-full bg-track" />
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

function Gauge({ tile }: { tile: Tile }) {
  return (
    <div className="grid content-start gap-2.5 px-5 py-4 @2xl:py-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-muted-foreground">{tile.heading}</p>
        <p className={cn("text-2xl leading-7 font-semibold tracking-title tabular-nums", LEVEL_TEXT[tile.level])}>
          {tile.value}
        </p>
      </div>
      <Track tile={tile} />
      <p className="text-xs text-muted-foreground tabular-nums">{tile.detail}</p>
    </div>
  )
}

function spec(value: number | null, unit: string): string {
  return value === null ? `${ABSENT} ${unit}` : `${size(value)} ${unit}`
}

/** The plate's columns: the server's identity, then its three gauges. */
const PLATE_GRID =
  "grid divide-y @2xl:grid-cols-[minmax(0,13rem)_repeat(3,minmax(0,1fr))] @2xl:divide-x @2xl:divide-y-0"

/**
 * The machine plate: a single VM serves every site, and what it runs short of
 * runs short for everyone, hence its place at the top of the home page. One
 * bordered panel in four cells: the server, its zone and its size, then the
 * load, the memory and the disk. Its columns follow its own width, like
 * everything laid out inside the content.
 */
export function MachinePlate({ snapshot }: { snapshot: Snapshot }) {
  const titleId = useId()
  const { machine } = snapshot
  const cores = machine?.cores ?? null
  return (
    <section aria-labelledby={titleId} className="@container overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className={PLATE_GRID}>
        <div className="grid content-start gap-1 px-5 py-4 @2xl:py-5">
          <h2 id={titleId} className="text-xs text-muted-foreground">
            Server
          </h2>
          {snapshot.zone !== "" && <p className="text-base font-semibold wrap-anywhere">{snapshot.zone}</p>}
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
            <li>{cores === null ? `${ABSENT} cores` : `${cores} ${cores === 1 ? "core" : "cores"}`}</li>
            <li>{spec(machine?.memoryTotal ?? null, "memory")}</li>
            <li>{spec(machine?.diskTotal ?? null, "disk")}</li>
          </ul>
        </div>
        <Gauge tile={loadTile(machine)} />
        <Gauge tile={memoryTile(machine)} />
        <Gauge tile={diskTile(machine)} />
      </div>
    </section>
  )
}

export function PlateSkeleton() {
  return (
    <div aria-hidden="true" className="@container">
      <div className={cn(PLATE_GRID, "rounded-xl border bg-card @2xl:h-[7.75rem]")}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid content-start gap-3 px-5 py-4 @2xl:py-5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-14" />
            {index > 0 && <Skeleton className="h-1.5 w-full" />}
          </div>
        ))}
      </div>
    </div>
  )
}
