import { Skeleton } from "@/components/ui/skeleton"
import {
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  loadTile,
  diskTile,
  memoryTile,
  type Level,
  type Tile,
} from "@/lib/gauges"
import type { MemoryReading } from "@/lib/sites"
import type { Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The figure takes its bar's colour beyond the first threshold, on the plate as on a service's card. */
export const LEVEL_TEXT: Record<Level, string> = {
  normal: "",
  warn: "text-attention-text",
  critical: "text-destructive",
}

const RING_STROKE: Record<Level, string> = {
  normal: "stroke-primary",
  warn: "stroke-attention",
  critical: "stroke-destructive",
}

/**
 * A share as an 18 px ring: a grey track and an arc from the top, clockwise,
 * in the level's colour: a service's memory against its limit, everywhere
 * the page shows it (`MemoryUsage`), read at a glance down a column. A
 * share under 1 % still draws a dot, the round cap of a zero-length arc.
 */
export function UsageRing({ percent, level = "normal" }: { percent: number; level?: Level }) {
  const radius = 7
  const length = 2 * Math.PI * radius
  const share = Math.min(Math.max(percent, 0), 100) / 100
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] shrink-0" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} fill="none" className="stroke-input" strokeWidth={3} />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        className={RING_STROKE[level]}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${share * length} ${length}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  )
}

/**
 * A service's memory wherever it is shown, the Sites list's way: its ring,
 * then its figure, muted while fine unless `muted` is off, amber or red near
 * the limit; the limit, the share and the peak in its tooltip, and the share
 * for a screen reader beside the figure.
 */
export function MemoryUsage({ reading, muted = true, className }: { reading: MemoryReading; muted?: boolean; className?: string }) {
  const { percent, level, text, title } = reading
  return (
    <span title={title} className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {percent !== null && <UsageRing percent={percent} level={level} />}
      <span className={cn("whitespace-nowrap tabular-nums", level !== "normal" ? cn("font-medium", LEVEL_TEXT[level]) : muted && "text-muted-foreground")}>
        {text}
        {percent !== null && <span className="sr-only">, {percent}% of its limit</span>}
      </span>
    </span>
  )
}

/**
 * One readout of the strip: its label, a 56 px bar, its figure in its
 * level's colour and, once the line has 56 rem, the machine's size in muted
 * text: the three keep to one line rather than wrap.
 * `onPress` makes it the button of a sort, `sortWord` naming it: the question
 * the figure raises, which site holds it, answered by the list below.
 */
function StripReadout({ tile, sortWord, pressed, onPress }: { tile: Tile; sortWord?: string; pressed?: boolean; onPress?: () => void }) {
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
      title={pressed ? `Sites sorted by ${sortWord}` : `Sort sites by ${sortWord}`}
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
 * cores", "5.7 of 12 GB used"), its zone in the sidebar. Each sorts the list
 * by what each site takes of it, Load by CPU, `sort` saying which is in force.
 */
export function MachineStrip({
  snapshot,
  sort,
  onSort,
}: {
  snapshot: Snapshot
  sort: string | null
  onSort: (sort: "cpu" | "memory" | "disk") => void
}) {
  const { machine } = snapshot
  return (
    <section aria-label="Server" className="@container/strip -my-1 flex flex-wrap items-center gap-x-8 gap-y-1">
      <StripReadout tile={loadTile(machine)} sortWord="CPU" pressed={sort === "cpu"} onPress={() => onSort("cpu")} />
      <StripReadout tile={memoryTile(machine)} sortWord="memory" pressed={sort === "memory"} onPress={() => onSort("memory")} />
      <StripReadout tile={diskTile(machine)} sortWord="disk" pressed={sort === "disk"} onPress={() => onSort("disk")} />
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
