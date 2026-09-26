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
 * A gauge's track, and the two thresholds engraved on it: a notch in the bar
 * and a tick below it, at 70 and 90 %. At a glance you read the distance to the
 * next threshold, not only the colour of the moment.
 *
 * A site's card reuses it for a service's memory: its thresholds are then the
 * service's, and the notch takes the white panel's colour instead of the
 * plate's.
 */
export function Track({
  tile,
  thresholds = THRESHOLD_POSITIONS,
  title = `Warning from ${WARNING_THRESHOLD}%, critical from ${CRITICAL_THRESHOLD}%`,
  notch = "bg-plaque",
}: {
  tile: Tile
  thresholds?: readonly { position: string }[]
  title?: string
  /** The colour of the background the track sits on, which makes the notch. */
  notch?: string
}) {
  return (
    <div className="relative pb-2.5" title={title}>
      {/* The bar is capped at one hundred, the figure is not: a load of six on four cores reads 150 %. */}
      {tile.percent === null ? (
        <div className="h-2 w-full rounded-full bg-foreground/10" />
      ) : (
        <Progress
          value={Math.min(tile.percent, 100)}
          aria-label={tile.heading}
          getAriaValueText={() => `${tile.value} used`}
          className={cn(
            "w-full [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-foreground/10",
            BAR_CLASSES[tile.level],
          )}
        />
      )}
      {thresholds.map(({ position }) => (
        <span key={position} aria-hidden="true" className={cn("pointer-events-none absolute top-0 h-full", position)}>
          <span className={cn("absolute top-0 h-2 w-0.5 -translate-x-1/2", notch)} />
          <span className="absolute bottom-0 h-1.5 w-px -translate-x-1/2 bg-foreground/35" />
        </span>
      ))}
    </div>
  )
}

function Gauge({ tile }: { tile: Tile }) {
  return (
    <div className="grid content-start gap-2 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3 @2xl:grid @2xl:justify-start @2xl:gap-0.5">
        <p className="text-sm text-muted-foreground">{tile.heading}</p>
        <p
          className={cn(
            "font-display text-[1.75rem] leading-8 font-semibold tracking-tight tabular-nums",
            LEVEL_TEXT[tile.level],
          )}
        >
          {tile.value}
        </p>
      </div>
      <Track tile={tile} />
      <p className="-mt-1 text-xs text-muted-foreground tabular-nums">{tile.detail}</p>
    </div>
  )
}

function spec(value: number | null, unit: string): string {
  return value === null ? `${ABSENT} ${unit}` : `${size(value)} ${unit}`
}

/**
 * The machine plate: a single VM serves every site, and what it runs short of
 * runs short for everyone, hence its place at the top of Overview. It is
 * dark in both themes, a `dark` island like the landing page's deep sections:
 * the `dark` class flips the tokens back there. Its four columns follow its own
 * width, like everything laid out inside the content.
 */
export function MachinePlate({ snapshot }: { snapshot: Snapshot }) {
  const titleId = useId()
  const { machine } = snapshot
  const cores = machine?.cores ?? null
  return (
    <section
      aria-labelledby={titleId}
      className="dark @container overflow-hidden rounded-xl border border-transparent bg-plaque text-foreground dark:border-border"
    >
      <div className="grid divide-y divide-border @2xl:grid-cols-[minmax(0,11rem)_repeat(3,minmax(0,1fr))] @2xl:divide-x @2xl:divide-y-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-4 @2xl:grid @2xl:content-start @2xl:gap-1">
          <h2 id={titleId} className="font-display text-base font-semibold tracking-tight">
            Server
          </h2>
          <ul className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums @2xl:grid @2xl:gap-0.5">
            <li>{cores === null ? `${ABSENT} cores` : `${cores} ${cores === 1 ? "core" : "cores"}`}</li>
            <li>{spec(machine?.memoryTotal ?? null, "memory")}</li>
            <li>{spec(machine?.diskTotal ?? null, "disk")}</li>
          </ul>
        </div>
        <Gauge tile={memoryTile(machine)} />
        <Gauge tile={diskTile(machine)} />
        <Gauge tile={loadTile(machine)} />
      </div>
    </section>
  )
}

export function PlateSkeleton() {
  return (
    <div aria-hidden="true" className="@container">
      <div className="dark grid h-auto divide-y divide-border rounded-xl bg-plaque @2xl:h-[7.75rem] @2xl:grid-cols-[minmax(0,11rem)_repeat(3,minmax(0,1fr))] @2xl:divide-x @2xl:divide-y-0">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid content-start gap-3 px-5 py-4">
            <Skeleton className="h-3.5 w-16 bg-foreground/10" />
            <Skeleton className="h-6 w-14 bg-foreground/10" />
            {index > 0 && <Skeleton className="h-2 w-full bg-foreground/10" />}
          </div>
        ))}
      </div>
    </div>
  )
}
