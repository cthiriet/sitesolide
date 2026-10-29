import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  AppWindow,
  CalendarClock,
  CircleDashed,
  Cog,
  Database,
  Files,
  Maximize,
  Minus,
  MousePointer2,
  Plug,
  Plus,
  RotateCcw,
  Waypoints,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { CHIP } from "@/components/access-word"
import { MemoryUsage } from "@/components/gauge"
import { accessEntry } from "@/components/legend"
import { ExternalLink } from "@/components/link"
import { StateLabel, Tile } from "@/components/page"
import { accessKey } from "@/lib/legend"
import {
  EDGE_WORDS,
  bounds,
  buildMap,
  FRAME_PADDING,
  FRAME_TITLE,
  LABEL_HEIGHT,
  edgeBadge,
  labelWidth,
  placeLabels,
  figuresLine,
  frameOf,
  kindLabel,
  layout,
  nodeState,
  routeEdges,
  scheduleLabel,
  type EdgeState,
  type MapEdge,
  type MapNode,
  type NodeKind,
  type Point,
  type Rect,
  type Size,
} from "@/lib/service-map"
import { memoryReading, siteAccess, siteAddress } from "@/lib/sites"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's services on a canvas, Railway's way: each a card, who talks to
 * whom a curve between them, visitors on the left, what leaves the machine
 * on the right, the project's walls drawn around its own. The canvas pans by
 * dragging its ground or scrolling, zooms with a pinch, Ctrl and the wheel,
 * or its buttons; a card is dragged where its reader wants it, kept in this
 * browser, and opens its sheet when pressed.
 *
 * What it draws is lib/service-map.ts's; this file only measures, places and
 * answers gestures.
 */

// --- What each node looks like -------------------------------------------------------

const ICON: Record<NodeKind, LucideIcon> = {
  visitors: MousePointer2,
  outside: CircleDashed,
  files: Files,
  server: AppWindow,
  worker: Cog,
  scheduled: CalendarClock,
  database: Database,
  egress: Waypoints,
  connectors: Plug,
  internet: Waypoints,
}

/** A node's width; its height is measured. Services are the widest, being the ones read. */
const WIDTH: Record<NodeKind, number> = {
  visitors: 224,
  outside: 208,
  files: 208,
  server: 236,
  worker: 236,
  scheduled: 236,
  database: 236,
  egress: 216,
  connectors: 216,
  internet: 216,
}

/** A height to place a node by until it is measured. */
const GUESS = 104

const MIN_ZOOM = 0.3
const MAX_ZOOM = 2
/** Under this width, the map is laid top to bottom: a phone's. */
const VERTICAL_BELOW = 640
/** A pointer that moves less than this has pressed, not dragged. */
const DRAG_THRESHOLD = 4

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

// --- The edges' look -----------------------------------------------------------------

/** Stroke and arrow of an edge, by how sure it is: strong when open now, quiet when seen or routed, dashed when only declared. */
const EDGE_STROKE: Record<EdgeState, string> = {
  open: "stroke-secondary-foreground",
  seen: "stroke-tick",
  routed: "stroke-tick",
  declared: "stroke-tick [stroke-dasharray:5_5]",
}
const EDGE_WIDTH: Record<EdgeState, number> = { open: 2, seen: 1.5, routed: 1.5, declared: 1.5 }
const EDGE_MARKER: Record<EdgeState, "strong" | "quiet"> = { open: "strong", seen: "quiet", routed: "quiet", declared: "quiet" }

function Markers({ prefix }: { prefix: string }) {
  const arrow = (name: string, className: string) => (
    <marker id={`${prefix}-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M 1 1.5 L 9 5 L 1 8.5 z" className={className} />
    </marker>
  )
  return (
    <defs>
      {arrow("strong", "fill-secondary-foreground")}
      {arrow("quiet", "fill-tick")}
      {arrow("accent", "fill-primary")}
    </defs>
  )
}

// --- The cards -----------------------------------------------------------------------

/** A machine string in a chip: a path, a port. */
function MonoChip({ title, className, children }: { title?: string; className?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn(CHIP, "max-w-full font-mono font-normal text-secondary-foreground", className)}>
      <span className="truncate">{children}</span>
    </span>
  )
}

function WordChip({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn(CHIP, "font-normal text-secondary-foreground")}>
      {children}
    </span>
  )
}

/** A card's head: its kind on a tile, its name, a line under it. */
function CardHead({ icon, title, subtitle, state }: { icon: LucideIcon; title: ReactNode; subtitle?: ReactNode; state?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Tile icon={icon} size={32} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-strong">{title}</span>
          {state}
        </div>
        {subtitle !== undefined && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
      </div>
    </div>
  )
}

/** A service: its kind, its name and unit, its state when not fine, what reaches it, and what it weighs. */
function ServiceCard({ node, now }: { node: MapNode; now: number }) {
  const service = node.service!
  const state = nodeState(service)
  const figures = figuresLine(service, now)
  const unit = service.service
  const memory = unit !== null && unit.active === "active" && unit.memory !== null ? memoryReading(unit.memory, unit.peak, unit.limit, true) : null
  const schedule = scheduleLabel(service)
  return (
    <>
      <CardHead
        icon={ICON[node.kind]}
        title={<span title={`${service.unit}.service`}>{service.name ?? service.unit}</span>}
        subtitle={service.main ? `${kindLabel(service)}, main service` : kindLabel(service)}
      />
      {state !== null && (
        <StateLabel tone={state.tone} className="-mt-1">
          {state.label}
        </StateLabel>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden">
        {service.port !== null && (
          <MonoChip
            title={service.listening === false ? `Nothing listens on 127.0.0.1:${service.port}` : `Listens on 127.0.0.1:${service.port}`}
            className={cn(service.listening === false && "border-destructive/40 text-destructive")}
          >
            :{service.port}
          </MonoChip>
        )}
        {schedule !== null &&
          (schedule.mono ? <MonoChip title="Its schedule, as systemd reads it">{schedule.text}</MonoChip> : <WordChip>{schedule.text}</WordChip>)}
        {service.backup !== null && <MonoChip title="The folder it keeps live, saved by its backup command">data/{service.backup}</MonoChip>}
      </div>
      {(memory !== null || figures.length > 0) && service.kind !== "scheduled" && (
        // Its memory as the Sites list draws it, then its other figures on the same line.
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          {memory !== null && <MemoryUsage reading={memory} className="shrink-0" />}
          {figures.length > 0 && <span className="min-w-0 truncate">{`${memory === null ? "" : "· "}${figures.join(" · ")}`}</span>}
        </p>
      )}
      {figures.length > 0 && service.kind === "scheduled" && (
        // A scheduled service's last and next runs, one under the other.
        <p className="grid min-w-0 text-xs text-muted-foreground tabular-nums">
          {figures.map((figure) => (
            <span key={figure} className="truncate">
              {figure}
            </span>
          ))}
        </p>
      )}
    </>
  )
}

/** Visitors: the address they use, and how the site lets them in. */
function VisitorsCard({ site }: { site: Site }) {
  const address = siteAddress(site)
  const { icon: AccessGlyph, label, tone } = accessEntry(accessKey(siteAccess(site)))
  return (
    <>
      <CardHead icon={ICON.visitors} title="Visitors" subtitle="Through Caddy, over HTTPS" />
      <div className="grid gap-1.5">
        <ExternalLink href={address.href} className="truncate font-mono text-xs text-foreground">
          {address.text}
        </ExternalLink>
        <span className="inline-flex items-center gap-1.5 text-xs text-secondary-foreground">
          <AccessGlyph aria-hidden="true" className={cn("size-3.5", tone)} />
          {label}
        </span>
      </div>
    </>
  )
}

function FilesCard({ site }: { site: Site }) {
  return (
    <>
      <CardHead icon={ICON.files} title="Static files" subtitle="Served before any service wakes" />
      <MonoChip title="Its publicDir">{`${site.publicDir}/`}</MonoChip>
    </>
  )
}

/** At most this many hosts on the card; the rest in its tooltip. */
const HOSTS_SHOWN = 4

function EgressCard({ site }: { site: Site }) {
  const hosts = site.network.egress
  const rest = hosts.slice(HOSTS_SHOWN)
  return (
    <>
      <CardHead icon={ICON.egress} title="Egress proxy" subtitle={hosts.length === 0 ? "Seen in use" : "These hosts, and no other"} />
      {hosts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hosts.slice(0, HOSTS_SHOWN).map((host) => (
            <MonoChip key={host}>{host}</MonoChip>
          ))}
          {rest.length > 0 && <WordChip title={rest.join(", ")}>+{rest.length}</WordChip>}
        </div>
      )}
    </>
  )
}

function ConnectorsCard({ site }: { site: Site }) {
  const names = site.network.connectors
  return (
    <>
      <CardHead icon={ICON.connectors} title="Connectors" subtitle="Lent by the machine" />
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {names.map((name) => (
            <MonoChip key={name}>{name}</MonoChip>
          ))}
        </div>
      )}
    </>
  )
}

function Card({ node, site, now }: { node: MapNode; site: Site; now: number }) {
  switch (node.kind) {
    case "visitors":
      return <VisitorsCard site={site} />
    case "files":
      return <FilesCard site={site} />
    case "egress":
      return <EgressCard site={site} />
    case "connectors":
      return <ConnectorsCard site={site} />
    case "internet":
      return <CardHead icon={ICON.internet} title="Any host" subtitle="Outbound network, no proxy" />
    case "outside":
      return <CardHead icon={ICON.outside} title="Another process" subtitle={`None of ${site.slug}'s services`} />
    default:
      return <ServiceCard node={node} now={now} />
  }
}

// --- What the reader moved -----------------------------------------------------------

/** Where cards were dragged, laid left to right and top to bottom apart: a place in one means nothing in the other. */
type Moved = { horizontal: Record<string, Point>; vertical: Record<string, Point> }

function readPoints(value: unknown): Record<string, Point> {
  if (typeof value !== "object" || value === null) return {}
  const kept: Record<string, Point> = {}
  for (const [id, point] of Object.entries(value as Record<string, unknown>)) {
    const p = point as Partial<Point> | null
    if (typeof p?.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) kept[id] = { x: p.x, y: p.y }
  }
  return kept
}

/**
 * Where the reader dragged each card, in this browser alone, per site: a
 * convenience, gone with the site data of the browser, and never a reason
 * the map would not draw.
 */
function useMoved(slug: string): [Moved, (next: Moved) => void] {
  const key = `service-map:${slug}`
  const [moved, setMoved] = useState<Moved>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Partial<Record<keyof Moved, unknown>> | null
      return { horizontal: readPoints(stored?.horizontal), vertical: readPoints(stored?.vertical) }
    } catch {
      return { horizontal: {}, vertical: {} }
    }
  })
  const store = useCallback(
    (next: Moved) => {
      setMoved(next)
      try {
        if (Object.keys(next.horizontal).length + Object.keys(next.vertical).length === 0) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage refused: the cards stay where they were dragged until the page is left.
      }
    },
    [key],
  )
  return [moved, store]
}

/** Room left around the map when it is fitted, and along the bottom for the controls. */
function fitMargin(phone: boolean): number {
  return phone ? 20 : 40
}
const CONTROLS = 44

/** The zoom at which `extent` fits in `box`, at most its natural size. */
function fitZoom(extent: Size, box: Size, phone: boolean): number {
  const margin = fitMargin(phone)
  if (extent.width === 0 || extent.height === 0) return 1
  return clamp(Math.min((box.width - 2 * margin) / extent.width, (box.height - 2 * margin - CONTROLS) / extent.height), MIN_ZOOM, 1)
}

/** A laid map's extent with its frame around the services: what a fit has to show. */
function extentOf(placed: { width: number; height: number }): Size {
  return { width: placed.width + 2 * FRAME_PADDING, height: placed.height + 2 * FRAME_PADDING + FRAME_TITLE }
}

/** Laid top to bottom when it reads larger so by this much: left to right stays the habit. */
const VERTICAL_GAIN = 1.2

// --- The canvas ----------------------------------------------------------------------

type View = { x: number; y: number; k: number }

/** A gesture in progress: the ground panned, a card dragged, or two fingers pinching. */
type Gesture =
  | { kind: "pan"; pointer: number; from: Point; view: View; dragging: boolean }
  | { kind: "card"; pointer: number; id: string; from: Point; origin: Point; dragging: boolean }
  | { kind: "pinch"; distance: number; centre: Point; view: View }

export function ServiceMap({
  site,
  now,
  selected,
  onSelect,
  className,
}: {
  site: Site
  /** The server's clock, which the links' dates are on. */
  now: number
  /** The service whose sheet is open. */
  selected: string | null
  onSelect: (unit: string) => void
  className?: string
}) {
  const map = useMemo(() => buildMap(site), [site])
  const markerPrefix = useId().replace(/:/g, "")
  const help = useId()
  const container = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Size | null>(null)
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [moved, storeMoved] = useMoved(site.slug)
  const [dragged, setDragged] = useState<Record<string, Point>>({})
  const gesture = useRef<Gesture | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const swallowClick = useRef(false)
  const fitted = useRef<string | null>(null)

  const phone = box !== null && box.width < VERTICAL_BELOW

  // The canvas's own size, which decides how the map is laid and fitted.
  useLayoutEffect(() => {
    const element = container.current
    if (element === null) return
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Each card's height, measured as it renders: what it holds decides it.
  const observer = useRef<ResizeObserver | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  useLayoutEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      setSizes((previous) => {
        let next = previous
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          const id = element.dataset.node
          if (id === undefined) continue
          const size = { width: element.offsetWidth, height: element.offsetHeight }
          const known = previous[id]
          if (known !== undefined && known.width === size.width && known.height === size.height) continue
          if (next === previous) next = { ...previous }
          next[id] = size
        }
        return next
      })
    })
    for (const element of elements.current.values()) observer.current.observe(element)
    return () => observer.current?.disconnect()
  }, [])
  // One ref per card, kept across renders, so that a render does not unobserve and observe each card again.
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const measure = useCallback((id: string) => {
    let ref = refs.current.get(id)
    if (ref === undefined) {
      ref = (element: HTMLElement | null) => {
        const known = elements.current.get(id)
        if (known !== undefined && known !== element) observer.current?.unobserve(known)
        if (element === null) {
          elements.current.delete(id)
          return
        }
        elements.current.set(id, element)
        observer.current?.observe(element)
      }
      refs.current.set(id, ref)
    }
    return ref
  }, [])

  const sizeOf = useCallback((id: string): Size => {
    const node = map.nodes.find((candidate) => candidate.id === id)
    return sizes[id] ?? { width: WIDTH[node?.kind ?? "server"], height: GUESS }
  }, [map, sizes])
  const measured = map.nodes.every((node) => sizes[node.id] !== undefined)

  // Left to right, unless top to bottom shows it larger, as on a phone: decided on the map as laid, before anyone's moves, so a drag never turns it.
  const vertical = useMemo(() => {
    if (box === null) return false
    if (phone) return true
    const across = fitZoom(extentOf(layout(map, sizeOf, false)), box, false)
    const down = fitZoom(extentOf(layout(map, sizeOf, true)), box, false)
    return down > across * VERTICAL_GAIN
  }, [map, sizeOf, box, phone])
  const orientation = vertical ? "vertical" : "horizontal"
  const ownMoves = moved[orientation]

  // Laid out, then the reader's own moves, the one in progress last.
  const placed = useMemo(() => layout(map, sizeOf, vertical, { ...ownMoves, ...dragged }), [map, sizeOf, vertical, ownMoves, dragged])
  const rects = useMemo(() => {
    const found = new Map<string, Rect>()
    for (const [id, point] of placed.places) found.set(id, { ...point, ...sizeOf(id) })
    return found
  }, [placed, sizeOf])
  const frame = useMemo(() => frameOf(map, rects, vertical), [map, rects, vertical])
  const routes = useMemo(() => routeEdges(map.edges, rects, vertical, placed), [map, rects, vertical, placed])
  const extent = useMemo(() => bounds(frame === null ? rects.values() : [...rects.values(), frame]), [rects, frame])

  /** The whole map in view, at most at its natural size, with room for the controls along the bottom. */
  const fit = useCallback(() => {
    if (box === null || extent.width === 0) return
    const k = fitZoom(extent, box, phone)
    setView({ k, x: (box.width - extent.width * k) / 2 - extent.x * k, y: (box.height - CONTROLS - extent.height * k) / 2 - extent.y * k })
  }, [box, extent, phone])

  // Fitted once measured, and again when the map changes shape: another site, another orientation, a service more or less.
  const shape = `${site.slug}|${orientation}|${map.nodes.map((node) => node.id).join(",")}`
  useLayoutEffect(() => {
    if (!measured || box === null || fitted.current === shape) return
    fitted.current = shape
    fit()
  }, [measured, box, shape, fit])

  const zoomAt = useCallback((point: Point, factor: number) => {
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = k / current.k
      return { k, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio }
    })
  }, [])
  const zoomCentre = (factor: number) => box !== null && zoomAt({ x: box.width / 2, y: box.height / 2 }, factor)

  // The wheel pans, and zooms with Ctrl or a trackpad's pinch, which browsers send as one: never the page's scroll while over the map.
  useEffect(() => {
    const element = container.current
    if (element === null) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.01))
        return
      }
      const scale = event.deltaMode === 1 ? 16 : 1
      setView((current) => ({ ...current, x: current.x - event.deltaX * scale, y: current.y - event.deltaY * scale }))
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [zoomAt])

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = container.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    swallowClick.current = false
    pointers.current.set(event.pointerId, local(event))
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      gesture.current = { kind: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y), centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view }
      return
    }
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-node]")
    // A link inside a card stays a link; the controls and the legend are no ground to pan.
    if ((event.target as HTMLElement).closest("a, [data-map-chrome]") !== null) return
    if (card !== null && !phone) {
      const id = card.dataset.node!
      const origin = placed.places.get(id)
      if (origin !== undefined) gesture.current = { kind: "card", pointer: event.pointerId, id, from: local(event), origin, dragging: false }
      return
    }
    // On a phone, a card is not moved: a finger on it moves the map, and a press still opens it.
    gesture.current = { kind: "pan", pointer: event.pointerId, from: local(event), view, dragging: card === null }
    if (card === null) container.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const point = local(event)
    pointers.current.set(event.pointerId, point)
    const current = gesture.current
    if (current === null) return
    if (current.kind === "pinch") {
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const k = clamp(current.view.k * (distance / current.distance), MIN_ZOOM, MAX_ZOOM)
      const ratio = k / current.view.k
      const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      setView({ k, x: centre.x - (current.centre.x - current.view.x) * ratio, y: centre.y - (current.centre.y - current.view.y) * ratio })
      return
    }
    if (event.pointerId !== current.pointer) return
    const dx = point.x - current.from.x
    const dy = point.y - current.from.y
    if (!current.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (current.kind === "pan") {
      if (!current.dragging) {
        current.dragging = true
        swallowClick.current = true
        container.current?.setPointerCapture(event.pointerId)
      }
      setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy })
      return
    }
    if (!current.dragging) {
      current.dragging = true
      container.current?.setPointerCapture(event.pointerId)
    }
    setDragged({ [current.id]: { x: Math.round(current.origin.x + dx / view.k), y: Math.round(current.origin.y + dy / view.k) } })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    const current = gesture.current
    if (current?.kind === "card" && current.pointer === event.pointerId && current.dragging) {
      swallowClick.current = true
      storeMoved({ ...moved, [orientation]: { ...ownMoves, ...dragged } })
      setDragged({})
    }
    if (current?.kind === "pinch" && pointers.current.size > 0) return
    gesture.current = null
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== container.current) return
    const step = 48
    const moves: Record<string, () => void> = {
      "+": () => zoomCentre(1.2),
      "=": () => zoomCentre(1.2),
      "-": () => zoomCentre(1 / 1.2),
      "0": fit,
      ArrowLeft: () => setView((v) => ({ ...v, x: v.x + step })),
      ArrowRight: () => setView((v) => ({ ...v, x: v.x - step })),
      ArrowUp: () => setView((v) => ({ ...v, y: v.y + step })),
      ArrowDown: () => setView((v) => ({ ...v, y: v.y - step })),
    }
    const move = moves[event.key]
    if (move === undefined) return
    event.preventDefault()
    move()
  }

  const active = hovered ?? selected
  const touches = (edge: MapEdge) => active !== null && (edge.from === active || edge.to === active)
  const near = useMemo(() => {
    if (active === null) return null
    const ids = new Set([active])
    for (const edge of map.edges) if (edge.from === active || edge.to === active) ids.add(edge.from).add(edge.to)
    return ids
  }, [active, map])
  const ordered = [...map.edges].sort((a, b) => Number(touches(a)) - Number(touches(b)))

  // The labels shown: every route's, then a lit edge's badge; each slid along its line to where it covers no card and no other label.
  const labels = useMemo(() => {
    const lit = (edge: MapEdge) => active !== null && (edge.from === active || edge.to === active)
    const shown = map.edges.flatMap((edge) => {
      if (!routes.has(edge.id)) return []
      if (edge.label !== null) return [{ edge, text: edge.label, mono: edge.routes !== null && edge.routes.length > 0, lit: lit(edge) }]
      if (!lit(edge)) return []
      const badge = edgeBadge(edge, now)
      return [{ edge, text: badge.text, mono: badge.mono, lit: true }]
    })
    // The routes' first, which are always shown: a lit badge never moves them.
    shown.sort((a, b) => Number(a.edge.label === null) - Number(b.edge.label === null))
    const where = placeLabels(
      shown.map(({ edge, text, mono }) => ({ id: edge.id, route: routes.get(edge.id)!, width: labelWidth(text, mono), height: LABEL_HEIGHT })),
      rects.values(),
    )
    return shown.map((label) => ({ ...label, at: where.get(label.edge.id)! }))
  }, [map, routes, rects, active, now])
  const hasMoved = Object.keys(ownMoves).length > 0

  const world: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }
  const ground: CSSProperties = {
    backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--input) 85%, transparent) 1px, transparent 1.2px)",
    backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  }

  return (
    <div
      ref={container}
      role="group"
      tabIndex={0}
      aria-label={`Map of ${site.slug}'s services`}
      aria-describedby={help}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      style={ground}
      className={cn(
        "relative touch-none overflow-hidden rounded-xl border bg-sunk shadow-well outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        gesture.current?.kind === "pan" ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
    >
      <p id={help} className="sr-only">
        Drag the ground or scroll to move around, Ctrl and the wheel or a pinch to zoom; with the map focused, the arrow keys move, plus and minus zoom, zero fits it. Each service is a button that opens its details.
      </p>
      <div className={cn("absolute top-0 left-0", !measured && "invisible")} style={world}>
        {frame !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-2xl border border-dashed border-input bg-background/55"
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
          >
            <div className={cn("absolute inset-x-0 flex h-8 min-w-0 items-center gap-2 px-4 whitespace-nowrap", vertical ? "bottom-0" : "top-1")}>
              <span className="mono-label shrink-0 text-secondary-foreground normal-case">{site.slug}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{wallsLine(site)}</span>
            </div>
          </div>
        )}
        <svg aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={Math.max(1, placed.width)} height={Math.max(1, placed.height)}>
          <Markers prefix={markerPrefix} />
          {ordered.map((edge) => {
            const route = routes.get(edge.id)
            if (route === undefined) return null
            const lit = touches(edge)
            const dim = active !== null && !lit
            return (
              <path
                key={edge.id}
                d={route.d}
                fill="none"
                strokeWidth={lit ? EDGE_WIDTH[edge.state] + 0.5 : EDGE_WIDTH[edge.state]}
                strokeLinecap="round"
                markerEnd={`url(#${markerPrefix}-${lit ? "accent" : EDGE_MARKER[edge.state]})`}
                className={cn(EDGE_STROKE[edge.state], lit && "stroke-primary", dim && "opacity-25")}
              />
            )
          })}
        </svg>
        {labels.map(({ edge, text, mono, lit, at }) => (
          <span
            key={edge.id}
            data-edge-label
            className={cn(
              "pointer-events-none absolute z-10 max-w-48 -translate-x-1/2 -translate-y-1/2 truncate rounded-md border bg-popover px-1.5 py-px text-[0.6875rem] leading-4 whitespace-nowrap text-secondary-foreground shadow-raised",
              mono && "font-mono",
              // Lit, it is what is being read: above the cards, should it still brush one.
              lit && "z-30 border-highlight-line text-strong",
              active !== null && !lit && "opacity-40",
            )}
            style={{ left: at.x, top: at.y }}
          >
            {text}
          </span>
        ))}
        {map.nodes.map((node) => {
          const point = placed.places.get(node.id)
          if (point === undefined) return null
          const service = node.service !== null
          const state = service ? nodeState(node.service!) : null
          const isSelected = selected === node.id
          const faded = near !== null && !near.has(node.id)
          const style: CSSProperties = { left: point.x, top: point.y, width: WIDTH[node.kind] }
          const look = cn(
            "absolute z-20 grid content-start gap-2.5 rounded-xl border bg-card p-3 text-left text-sm shadow-panel transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none",
            state?.tone === "error" && "border-destructive/45",
            isSelected && "border-ring shadow-float ring-2 ring-ring/25",
            faded && "opacity-60",
            !phone && "cursor-grab active:cursor-grabbing",
          )
          if (!service)
            return (
              <div key={node.id} ref={measure(node.id)} data-node={node.id} className={look} style={style} onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered(null)}>
                <Card node={node} site={site} now={now} />
              </div>
            )
          return (
            <button
              key={node.id}
              ref={measure(node.id)}
              type="button"
              data-node={node.id}
              aria-pressed={isSelected}
              aria-label={`${node.service!.name ?? node.id}, ${kindLabel(node.service!)}${state === null ? "" : `, ${state.label}`}: open its details`}
              className={cn(look, "outline-none hover:border-input hover:shadow-float focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring")}
              style={style}
              onPointerEnter={() => setHovered(node.id)}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(node.id)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                if (swallowClick.current) {
                  swallowClick.current = false
                  return
                }
                onSelect(node.id)
              }}
            >
              <Card node={node} site={site} now={now} />
            </button>
          )
        })}
      </div>

      {!phone && <Legend />}
      <div data-map-chrome className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-float">
        {hasMoved && !phone && (
          <>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => storeMoved({ ...moved, [orientation]: {} })}>
              <RotateCcw />
              Reset layout
            </Button>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out" onClick={() => zoomCentre(1 / 1.2)} disabled={view.k <= MIN_ZOOM + 0.001}>
          <Minus />
        </Button>
        <button
          type="button"
          title="Actual size"
          onClick={() => box !== null && zoomAt({ x: box.width / 2, y: box.height / 2 }, 1 / view.k)}
          className="h-7 min-w-12 rounded-md px-1 text-xs text-secondary-foreground tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {Math.round(view.k * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in" onClick={() => zoomCentre(1.2)} disabled={view.k >= MAX_ZOOM - 0.001}>
          <Plus />
        </Button>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" aria-label="Fit to view" title="Fit to view" onClick={fit}>
          <Maximize />
        </Button>
      </div>
    </div>
  )
}

/** How far the project's walls let its services go: what the frame says beside its name. */
function wallsLine(site: Pick<Site, "network">): string {
  if (site.network.outbound) return "Outbound network"
  if (site.network.egress.length > 0 || site.network.connectors.length > 0) return "Loopback, out through the proxy"
  return "Loopback only"
}

/** The three ways an edge is drawn, and what each says. */
function Legend() {
  const entries: { state: EdgeState; label: string }[] = [
    { state: "open", label: EDGE_WORDS.open },
    { state: "seen", label: "Seen before, or routed" },
    { state: "declared", label: "Declared, not seen yet" },
  ]
  return (
    <div
      data-map-chrome
      className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-popover/95 px-3 py-2 text-xs text-secondary-foreground shadow-float"
    >
      {entries.map((entry) => (
        <span key={entry.state} className="inline-flex items-center gap-2">
          <svg aria-hidden="true" width="24" height="6" className="shrink-0 overflow-visible">
            <line x1="1" y1="3" x2="23" y2="3" strokeWidth={EDGE_WIDTH[entry.state]} strokeLinecap="round" className={EDGE_STROKE[entry.state]} />
          </svg>
          {entry.label}
        </span>
      ))}
    </div>
  )
}
