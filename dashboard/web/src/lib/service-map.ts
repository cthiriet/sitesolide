/**
 * A site's Services section as a map: its services as nodes, who talks to
 * whom as edges, visitors coming in on the left through Caddy, what leaves
 * the machine on the right. Pure, and therefore testable without a browser:
 * the graph from the snapshot, the place of each node from their measured
 * sizes, the path of each edge from those places.
 *
 * Nothing is judged anew. The links come from `src/state.ts`, which put the
 * collector's connections and the manifest's declarations under the site;
 * the words of a service's state come from lib/sites.ts, the same as the
 * Overview's.
 */
import { ago, plural } from "./format"
import { computeCpuShare, restartsLabel, runLines, scheduleWords, scheduledWord, serviceWord, type ServiceState } from "./sites"
import type { Tone } from "./tones"
import type { Site, SiteLink, SiteService } from "./types"

// --- The graph -------------------------------------------------------------------

/** What a node stands for. */
export type NodeKind =
  | "visitors"
  | "outside"
  | "files"
  | "server"
  | "worker"
  | "scheduled"
  | "database"
  | "egress"
  | "connectors"
  | "internet"

export type MapNode = {
  /** `visitors`, `files`, `outside`, `egress`, `connectors`, `internet`, or a service's unit. */
  id: string
  kind: NodeKind
  /** The service it stands for, for a service's node. */
  service: SiteService | null
  /** Its column, left to right: visitors, the services by who calls whom, then what leaves the machine. */
  layer: number
}

/**
 * How sure an edge is. `open`: connections were open at the last reading.
 * `seen`: one was, earlier, and none is now. `routed`: Caddy sends requests
 * there by its configuration, none seen yet. `declared`: the manifest names
 * the port, never seen used.
 */
export type EdgeState = "open" | "seen" | "routed" | "declared"

export type MapEdge = {
  id: string
  from: string
  to: string
  state: EdgeState
  /** Connections open at the last reading. */
  open: number
  /** When one was last seen open. */
  seen: number | null
  /** What names the port it reaches, in the manifest. */
  declared: string[]
  /** Declared in the project's env alone, which every service receives. */
  shared: boolean
  /** What Caddy sends along it: its paths, empty for every path no other service claims; null for an edge that is no route. */
  routes: string[] | null
  /** A route's words on the canvas: its paths, "All other paths", or "Every path" for the one service that takes them all. */
  label: string | null
}

export type ServiceMap = { nodes: MapNode[]; edges: MapEdge[] }

/** A service's kind on the map: one that keeps a database live, by its backup command, is a database. */
export function serviceKind(service: SiteService): NodeKind {
  return service.backup !== null ? "database" : service.kind
}

/** The order of a column, before who calls whom rearranges it: public first, then internal, then what runs on its own. */
const KIND_RANK: Record<NodeKind, number> = {
  visitors: 0,
  outside: 1,
  server: 2,
  files: 3,
  database: 4,
  worker: 5,
  scheduled: 6,
  egress: 7,
  connectors: 8,
  internet: 9,
}

const OUTBOUND = new Set(["egress", "connectors", "internet"])

function edgeState(link: Pick<SiteLink, "open" | "seen">, otherwise: EdgeState): EdgeState {
  if (link.open > 0) return "open"
  if (link.seen !== null) return "seen"
  return otherwise
}

/**
 * The map of a site: a node per service, visitors when it serves pages, its
 * files when Caddy serves some first, what its services may reach beyond the
 * loopback, and another process when one was seen calling them.
 *
 * Visitors reach each public service by its routes, whether or not a
 * connection was seen: Caddy's configuration says so. A link declared in
 * the project's env alone is left out from a database, which calls none of
 * its siblings. What leaves the machine is drawn from the services seen
 * reaching it; when none was, from every service that may, declared. So
 * is a sibling's port named in the project's env: once a service is seen
 * reaching it, the others' share of the variable is left out.
 */
export function buildMap(site: Pick<Site, "headless" | "publicDir" | "services" | "links" | "network">): ServiceMap {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const units = new Set(site.services.map((service) => service.unit))

  if (!site.headless) nodes.push({ id: "visitors", kind: "visitors", service: null, layer: 0 })
  if (site.links.some((link) => link.from === "outside" && units.has(link.to))) nodes.push({ id: "outside", kind: "outside", service: null, layer: 0 })
  if (site.publicDir !== null && !site.headless) nodes.push({ id: "files", kind: "files", service: null, layer: 1 })
  for (const service of site.services) nodes.push({ id: service.unit, kind: serviceKind(service), service, layer: 1 })

  const add = (edge: Omit<MapEdge, "id" | "label">) => edges.push({ ...edge, id: `${edge.from}>${edge.to}`, label: null })
  const linkOf = (from: string, to: string) => site.links.find((link) => link.from === from && link.to === to)

  // Visitors, through Caddy: its files first, then each public service by its routes.
  const routed = site.services.filter((service) => !service.internal && service.port !== null)
  const alone = routed.length === 1 && site.publicDir === null
  if (!site.headless) {
    if (site.publicDir !== null) add({ from: "visitors", to: "files", state: "routed", open: 0, seen: null, declared: [], shared: false, routes: null })
    for (const service of routed) {
      const link = linkOf("caddy", service.unit)
      add({
        from: "visitors",
        to: service.unit,
        state: link === undefined ? "routed" : edgeState(link, "routed"),
        open: link?.open ?? 0,
        seen: link?.seen ?? null,
        declared: [],
        shared: false,
        routes: service.routes ?? [],
      })
      edges[edges.length - 1]!.label = alone && service.routes == null ? "Every path" : routeLabel(service.routes ?? [])
    }
  }

  const databases = new Set(site.services.filter((service) => service.backup !== null).map((service) => service.unit))
  // A target some sibling was seen reaching: who uses the variable every service receives is known, the others' declarations say nothing more.
  const reached = new Set(site.links.filter((link) => link.from !== "caddy" && (link.open > 0 || link.seen !== null)).map((link) => link.to))
  for (const link of site.links) {
    if (link.from === "caddy" || OUTBOUND.has(link.to)) continue
    if (!units.has(link.to) || (link.from !== "outside" && !units.has(link.from))) continue
    const declaredOnly = link.open === 0 && link.seen === null
    if (declaredOnly && link.shared && (databases.has(link.from) || reached.has(link.to))) continue
    add({ from: link.from, to: link.to, state: edgeState(link, "declared"), open: link.open, seen: link.seen, declared: link.declared, shared: link.shared, routes: null })
  }

  // What leaves the machine: each way the manifest allows, or a service was seen taking.
  const outbound: { id: "egress" | "connectors" | "internet"; allowed: boolean }[] = [
    { id: "egress", allowed: site.network.egress.length > 0 },
    { id: "connectors", allowed: site.network.connectors.length > 0 },
    { id: "internet", allowed: site.network.outbound },
  ]
  for (const { id, allowed } of outbound) {
    const taken = site.links.filter((link) => link.to === id && units.has(link.from))
    if (!allowed && taken.length === 0) continue
    nodes.push({ id, kind: id, service: null, layer: 2 })
    if (taken.length > 0) {
      for (const link of taken) add({ from: link.from, to: id, state: edgeState(link, "declared"), open: link.open, seen: link.seen, declared: [], shared: false, routes: null })
      continue
    }
    for (const service of site.services) {
      if (databases.has(service.unit)) continue
      add({ from: service.unit, to: id, state: "declared", open: 0, seen: null, declared: [], shared: true, routes: null })
    }
  }

  assignLayers(nodes, edges)
  return { nodes, edges }
}

/**
 * The columns: who calls a service stands to its left. A service no other
 * calls starts the first column of services, beside the public ones, a
 * worker or a scheduled job being where work starts too; each other one
 * stands right of its furthest caller. A loop is cut where it closes. What
 * leaves the machine takes the column after the last service's.
 */
function assignLayers(nodes: MapNode[], edges: readonly MapEdge[]): void {
  const services = nodes.filter((node) => node.service !== null)
  const ids = new Set(services.map((node) => node.id))
  const callers = new Map<string, string[]>()
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    callers.set(edge.to, [...(callers.get(edge.to) ?? []), edge.from])
  }
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let deepest = 1
    for (const caller of callers.get(id) ?? []) deepest = Math.max(deepest, depth(caller) + 1)
    visiting.delete(id)
    layer.set(id, deepest)
    return deepest
  }
  for (const node of services) node.layer = depth(node.id)
  const last = Math.max(1, ...services.map((node) => node.layer))
  for (const node of nodes) if (OUTBOUND.has(node.id)) node.layer = last + 1
  // A project that serves no page has no visitors' column: everything moves one to the left.
  if (!nodes.some((node) => node.layer === 0)) for (const node of nodes) node.layer -= 1
}

/**
 * A place in a column: a node, or the lane an edge longer than one column
 * takes through it, so that it passes between the cards rather than behind
 * one, the way a layered drawing does.
 */
export type Slot = { id: string; layer: number; node: MapNode | null; edge: MapEdge | null }

/** The edges that cross more than one column forward, each with its lanes, one per column it crosses. */
function lanesOf(map: ServiceMap): Map<string, Slot[]> {
  const layerOf = new Map(map.nodes.map((node) => [node.id, node.layer]))
  const lanes = new Map<string, Slot[]>()
  for (const edge of map.edges) {
    const from = layerOf.get(edge.from)
    const to = layerOf.get(edge.to)
    if (from === undefined || to === undefined || to - from < 2) continue
    const slots: Slot[] = []
    for (let layer = from + 1; layer < to; layer += 1) slots.push({ id: `${edge.id}@${layer}`, layer, node: null, edge })
    lanes.set(edge.id, slots)
  }
  return lanes
}

/**
 * Each column in its order, top to bottom: by kind and as the manifest lists
 * them, then, from the second column on, each node near the middle of what
 * reaches it, which keeps the edges from crossing where they need not. A
 * lane follows its edge's previous step.
 */
export function columns(map: ServiceMap): Slot[][] {
  const lanes = lanesOf(map)
  const count = Math.max(0, ...map.nodes.map((node) => node.layer)) + 1
  const result: Slot[][] = Array.from({ length: count }, () => [])
  const written = new Map(map.nodes.map((node, index) => [node.id, index]))
  for (const node of map.nodes) result[node.layer]!.push({ id: node.id, layer: node.layer, node, edge: null })
  for (const column of result) column.sort((a, b) => KIND_RANK[a.node!.kind] - KIND_RANK[b.node!.kind] || written.get(a.id)! - written.get(b.id)!)
  for (const slots of lanes.values()) for (const slot of slots) result[slot.layer]!.push(slot)

  // What reaches each slot from the column before: an edge's source or its previous lane.
  const before = new Map<string, string[]>()
  const step = (from: string, to: string) => before.set(to, [...(before.get(to) ?? []), from])
  for (const edge of map.edges) {
    const slots = lanes.get(edge.id)
    if (slots === undefined) {
      step(edge.from, edge.to)
      continue
    }
    const chain = [edge.from, ...slots.map((slot) => slot.id), edge.to]
    for (let index = 1; index < chain.length; index += 1) step(chain[index - 1]!, chain[index]!)
  }

  const after = new Map<string, string[]>()
  for (const [to, froms] of before) for (const from of froms) after.set(from, [...(after.get(from) ?? []), to])

  // A slot's place in its column, from its middle: columns of different lengths are centred on one another.
  const position = new Map<string, number>()
  const place = (column: Slot[]) => column.forEach((slot, index) => position.set(slot.id, index - (column.length - 1) / 2))
  const reorder = (column: Slot[], neighbours: ReadonlyMap<string, string[]>) => {
    const keyed = column.map((slot, index) => {
      const known = (neighbours.get(slot.id) ?? []).filter((id) => position.has(id)).map((id) => position.get(id)!)
      return { slot, index, key: known.length === 0 ? position.get(slot.id)! : known.reduce((sum, value) => sum + value, 0) / known.length }
    })
    keyed.sort((a, b) => a.key - b.key || a.index - b.index)
    column.splice(0, column.length, ...keyed.map((entry) => entry.slot))
    place(column)
  }
  result.forEach(place)
  // Down by what reaches each slot, up by what it reaches, down again: three sweeps undo most crossings a single one leaves.
  for (let layer = 1; layer < result.length; layer += 1) reorder(result[layer]!, before)
  for (let layer = result.length - 2; layer >= 1; layer -= 1) reorder(result[layer]!, after)
  for (let layer = 1; layer < result.length; layer += 1) reorder(result[layer]!, before)

  // Then two neighbours of a column swap places while that crosses fewer edges, or as many but shorter ones: what the sweeps leave.
  const cost = (layer: number): [number, number] => {
    let crossings = 0
    let length = 0
    for (const [neighbour, links] of [
      [result[layer - 1], before],
      [result[layer + 1], after],
    ] as const) {
      if (neighbour === undefined) continue
      const pairs: [number, number][] = []
      for (const slot of result[layer]!)
        for (const other of links.get(slot.id) ?? []) if (neighbour.some((candidate) => candidate.id === other)) pairs.push([position.get(slot.id)!, position.get(other)!])
      for (const [a, b] of pairs) length += Math.abs(a - b)
      for (let i = 0; i < pairs.length; i += 1)
        for (let j = i + 1; j < pairs.length; j += 1) if ((pairs[i]![0] - pairs[j]![0]) * (pairs[i]![1] - pairs[j]![1]) < 0) crossings += 1
    }
    return [crossings, length]
  }
  for (let round = 0; round < 4; round += 1) {
    let swapped = false
    for (let layer = 1; layer < result.length; layer += 1) {
      const column = result[layer]!
      for (let index = 0; index + 1 < column.length; index += 1) {
        const [crossings, length] = cost(layer)
        ;[column[index], column[index + 1]] = [column[index + 1]!, column[index]!]
        place(column)
        const [crossingsAfter, lengthAfter] = cost(layer)
        if (crossingsAfter < crossings || (crossingsAfter === crossings && lengthAfter < length - 0.001)) {
          swapped = true
          continue
        }
        ;[column[index], column[index + 1]] = [column[index + 1]!, column[index]!]
        place(column)
      }
    }
    if (!swapped) break
  }
  return result.filter((column) => column.length > 0)
}

// --- The places --------------------------------------------------------------------

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type Rect = Point & Size

/** The room between two columns, and between two nodes of one. Wide enough for a route's label and the frame's margin. */
export const COLUMN_GAP = 104
export const ROW_GAP = 28
/** Between two rows, laid top to bottom on a narrow screen: the frame's title fits in it. */
export const ROW_GAP_VERTICAL = 72
export const COLUMN_GAP_VERTICAL = 20

/** A column's extent along the flow: from its left edge to its right one, or its top to its bottom laid vertically. */
export type Band = { start: number; end: number }

/**
 * A laid map: each node's top left corner, the points each edge's lanes pass
 * through, each column's extent and the column of each node still in its own,
 * for the channels its edges take between two columns.
 */
export type Laid = { places: Map<string, Point>; lanes: Map<string, Point[]>; bands: Band[]; bandOf: Map<string, number>; width: number; height: number }

/** The room a lane takes in its column, along it. */
const LANE = 8

/**
 * Where each node stands, its top left corner, from the size it was measured
 * at: columns left to right, each centred on the tallest, or, `vertical`,
 * rows top to bottom, each centred on the widest. `moved` holds the nodes
 * someone dragged elsewhere, which keep their place; an edge that has one of
 * them at an end leaves its lanes, to go straight.
 */
export function layout(
  map: ServiceMap,
  sizeOf: (id: string) => Size,
  vertical = false,
  moved: Readonly<Record<string, Point>> = {},
): Laid {
  const places = new Map<string, Point>()
  const lanePoints = new Map<string, Point[]>()
  const bands: Band[] = []
  const bandOf = new Map<string, number>()
  const groups = columns(map)
  const extentOf = (slot: Slot): Size => (slot.node === null ? (vertical ? { width: LANE, height: 0 } : { width: 0, height: LANE }) : sizeOf(slot.id))
  const across = (size: Size) => (vertical ? size.height : size.width)
  const along = (size: Size) => (vertical ? size.width : size.height)
  const gapAcross = vertical ? ROW_GAP_VERTICAL : COLUMN_GAP
  const gapAlong = vertical ? COLUMN_GAP_VERTICAL : ROW_GAP

  const lengths = groups.map((group) => group.reduce((sum, slot) => sum + along(extentOf(slot)), 0) + gapAlong * (group.length - 1))
  const longest = Math.max(0, ...lengths)
  let offset = 0
  groups.forEach((group, index) => {
    const thickness = Math.max(...group.map((slot) => across(extentOf(slot))))
    bands.push({ start: offset, end: offset + thickness })
    let cursor = (longest - lengths[index]!) / 2
    for (const slot of group) {
      if (slot.node !== null) bandOf.set(slot.id, index)
      const size = extentOf(slot)
      if (slot.node === null) {
        // A lane: the point its edge passes through, in the middle of the column's thickness.
        const point = vertical ? { x: cursor + LANE / 2, y: offset + thickness / 2 } : { x: offset + thickness / 2, y: cursor + LANE / 2 }
        lanePoints.set(slot.edge!.id, [...(lanePoints.get(slot.edge!.id) ?? []), point])
      } else {
        // Centred in its column's thickness, so that a narrower node lines up with the others' middle.
        const inset = (thickness - across(size)) / 2
        places.set(slot.id, vertical ? { x: cursor, y: offset + inset } : { x: offset + inset, y: cursor })
      }
      cursor += along(size) + gapAlong
    }
    offset += thickness + gapAcross
  })

  for (const [id, point] of Object.entries(moved)) {
    if (!places.has(id)) continue
    places.set(id, point)
    // Out of its column: its edges are drawn from where it stands, by no column's channels.
    bandOf.delete(id)
  }
  for (const edge of map.edges) if (Object.hasOwn(moved, edge.from) || Object.hasOwn(moved, edge.to)) lanePoints.delete(edge.id)
  let width = 0
  let height = 0
  for (const [id, point] of places) {
    const size = sizeOf(id)
    width = Math.max(width, point.x + size.width)
    height = Math.max(height, point.y + size.height)
  }
  return { places, lanes: lanePoints, bands, bandOf, width, height }
}

/** The project's walls around its services and its files, with room for a title above them. */
export const FRAME_PADDING = 20
export const FRAME_TITLE = 32

export function frameOf(map: ServiceMap, rects: ReadonlyMap<string, Rect>, vertical = false): Rect | null {
  const inside = map.nodes.filter((node) => node.service !== null || node.kind === "files").map((node) => rects.get(node.id))
  const known = inside.filter((rect): rect is Rect => rect !== undefined)
  if (known.length === 0) return null
  // The title above the services, or under them laid top to bottom, where visitors' routes come in from above.
  const left = Math.min(...known.map((rect) => rect.x)) - FRAME_PADDING
  const top = Math.min(...known.map((rect) => rect.y)) - FRAME_PADDING - (vertical ? 0 : FRAME_TITLE)
  const right = Math.max(...known.map((rect) => rect.x + rect.width)) + FRAME_PADDING
  const bottom = Math.max(...known.map((rect) => rect.y + rect.height)) + FRAME_PADDING + (vertical ? FRAME_TITLE : 0)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Every point a rectangle covers, for the view's bounds: the nodes, and the frame that may stand out of them. */
export function bounds(rects: Iterable<Rect>): Rect {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// --- The edges ---------------------------------------------------------------------

export type Side = "left" | "right" | "top" | "bottom"
/** An edge's path as SVG draws it, the point its label prefers, its two ends, and the line it follows, for its label to slide along. */
export type Route = { d: string; mid: Point; start: Point; end: Point; points: Point[] }

/** Between two ends on one side, so that edges meeting a node do not overlap. */
const ANCHOR_SPACING = 12

/**
 * Which side an edge leaves by and which it enters by: forward, from the
 * right to the left; within one column, out of the right and back in by it;
 * backward, from the left to the right. Top and bottom in place of left and
 * right, laid vertically.
 */
function sides(a: Rect, b: Rect, vertical: boolean): { out: Side; in: Side } {
  if (vertical) {
    if (b.y >= a.y + a.height) return { out: "bottom", in: "top" }
    if (b.y + b.height <= a.y) return { out: "top", in: "bottom" }
    return { out: "right", in: "right" }
  }
  if (b.x >= a.x + a.width) return { out: "right", in: "left" }
  if (b.x + b.width <= a.x) return { out: "left", in: "right" }
  return { out: "right", in: "right" }
}

function anchor(rect: Rect, side: Side, offset: number): Point {
  switch (side) {
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 + offset }
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 + offset }
    case "top":
      return { x: rect.x + rect.width / 2 + offset, y: rect.y }
    case "bottom":
      return { x: rect.x + rect.width / 2 + offset, y: rect.y + rect.height }
  }
}

const NORMAL: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }

/** A cubic step between two points, leaving and entering square to the sides they face. */
function curve(start: Point, n1: Point, end: Point, n2: Point, reach: number): { c1: Point; c2: Point } {
  return { c1: { x: start.x + n1.x * reach, y: start.y + n1.y * reach }, c2: { x: end.x + n2.x * reach, y: end.y + n2.y * reach } }
}

const round = (value: number) => Math.round(value * 10) / 10

/** The radius of a bend, at most: smaller where the two runs it joins are shorter. */
const BEND = 10
/** Between two channels sharing the room between two columns, and between a channel and a card. */
const CHANNEL_SPACING = 14
const CHANNEL_MARGIN = 16

/**
 * A polyline with its bends rounded: straight runs, a quarter curve at each
 * turn, points that turn nothing dropped.
 */
export function roundedPath(points: readonly Point[]): string {
  const kept: Point[] = []
  for (const point of points) {
    const last = kept[kept.length - 1]
    if (last !== undefined && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue
    const before = kept[kept.length - 2]
    // Three points in one line: the middle one turns nothing.
    if (before !== undefined && last !== undefined && Math.abs((last.x - before.x) * (point.y - last.y) - (last.y - before.y) * (point.x - last.x)) < 0.5) kept.pop()
    kept.push(point)
  }
  if (kept.length === 0) return ""
  let d = `M ${round(kept[0]!.x)} ${round(kept[0]!.y)}`
  for (let index = 1; index < kept.length - 1; index += 1) {
    const p = kept[index - 1]!
    const q = kept[index]!
    const r = kept[index + 1]!
    const into = Math.hypot(q.x - p.x, q.y - p.y)
    const out = Math.hypot(r.x - q.x, r.y - q.y)
    const radius = Math.min(BEND, into / 2, out / 2)
    const a = { x: q.x - ((q.x - p.x) / into) * radius, y: q.y - ((q.y - p.y) / into) * radius }
    const b = { x: q.x + ((r.x - q.x) / out) * radius, y: q.y + ((r.y - q.y) / out) * radius }
    d += ` L ${round(a.x)} ${round(a.y)} Q ${round(q.x)} ${round(q.y)} ${round(b.x)} ${round(b.y)}`
  }
  const last = kept[kept.length - 1]!
  return kept.length === 1 ? d : `${d} L ${round(last.x)} ${round(last.y)}`
}

/**
 * The path of every edge, a circuit's way: out of its card square to the
 * side, along to a channel of its own in the room between two columns, across
 * there, and on into the next card, its bends rounded; through its lanes when
 * it crosses columns. The channels sharing a room are spread so that runs do
 * not cross where they need not: of two going down, the one that starts
 * higher turns further on; of two going up, the one that starts lower. The
 * ends sharing a side are spread along it in the order of what lies at their
 * other end.
 *
 * An edge whose card was dragged out of its column turns once, halfway; one
 * that runs back, or within one column, is a curve. Its label sits on its
 * lane, or on its first turn across.
 */
export function routeEdges(
  edges: readonly MapEdge[],
  rects: ReadonlyMap<string, Rect>,
  vertical = false,
  grid: Partial<Pick<Laid, "lanes" | "bands" | "bandOf">> = {},
): Map<string, Route> {
  const lanes = grid.lanes ?? new Map<string, Point[]>()
  const bands = grid.bands ?? []
  const bandOf = grid.bandOf ?? new Map<string, number>()
  type End = { edge: MapEdge; node: string; side: Side; toward: Point; role: "out" | "in" }
  const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
  const ends: End[] = []
  for (const edge of edges) {
    const a = rects.get(edge.from)
    const b = rects.get(edge.to)
    if (a === undefined || b === undefined) continue
    const way = sides(a, b, vertical)
    const through = lanes.get(edge.id) ?? []
    // What an end is sorted by on its side: the first lane, or the node at the other end.
    ends.push(
      { edge, node: edge.from, side: way.out, toward: through[0] ?? centre(b), role: "out" },
      { edge, node: edge.to, side: way.in, toward: through[through.length - 1] ?? centre(a), role: "in" },
    )
  }

  const offsets = new Map<End, number>()
  const groups = new Map<string, End[]>()
  for (const end of ends) {
    const key = `${end.node}:${end.side}`
    groups.set(key, [...(groups.get(key) ?? []), end])
  }
  for (const group of groups.values()) {
    const horizontalSide = group[0]!.side === "left" || group[0]!.side === "right"
    group.sort((p, q) => (horizontalSide ? p.toward.y - q.toward.y : p.toward.x - q.toward.x))
    group.forEach((end, index) => offsets.set(end, (index - (group.length - 1) / 2) * ANCHOR_SPACING))
  }

  // Along the flow and across it: x and y, or y and x laid top to bottom.
  const along = (point: Point) => (vertical ? point.y : point.x)
  const across = (point: Point) => (vertical ? point.x : point.y)
  const at = (onFlow: number, offFlow: number): Point => (vertical ? { x: offFlow, y: onFlow } : { x: onFlow, y: offFlow })

  // Each edge's stations, its two ends and its lanes, and each turn between two of them, with the room it takes.
  type Turn = { edge: string; room: number | null; from: number; to: number; channel: number }
  type Plan = { edge: MapEdge; stations: Point[]; turns: (Turn | null)[]; start: Point; end: Point }
  const plans: Plan[] = []
  const curves = new Map<string, { out: End; into: End }>()
  for (const edge of edges) {
    const out = ends.find((end) => end.edge === edge && end.role === "out")
    const into = ends.find((end) => end.edge === edge && end.role === "in")
    if (out === undefined || into === undefined) continue
    const start = anchor(rects.get(edge.from)!, out.side, offsets.get(out) ?? 0)
    const end = anchor(rects.get(edge.to)!, into.side, offsets.get(into) ?? 0)
    const forward = out.side === (vertical ? "bottom" : "right") && into.side === (vertical ? "top" : "left")
    if (!forward) {
      curves.set(edge.id, { out, into })
      continue
    }
    const through = lanes.get(edge.id) ?? []
    const first = bandOf.get(edge.from)
    const last = bandOf.get(edge.to)
    const columned = first !== undefined && last !== undefined && last - first - 1 === through.length && last > first
    const stations = [start, ...(columned ? through : []), end]
    const turns: (Turn | null)[] = []
    for (let index = 1; index < stations.length; index += 1) {
      const from = across(stations[index - 1]!)
      const to = across(stations[index]!)
      if (Math.abs(to - from) < 1) {
        turns.push(null)
        continue
      }
      const room = columned ? first! + index - 1 : null
      const halfway = (along(stations[index - 1]!) + along(stations[index]!)) / 2
      turns.push({ edge: edge.id, room, from, to, channel: halfway })
    }
    plans.push({ edge, stations, turns, start, end })
  }

  // The channels of each room between two columns.
  const rooms = new Map<number, Turn[]>()
  for (const plan of plans) for (const turn of plan.turns) if (turn !== null && turn.room !== null) rooms.set(turn.room, [...(rooms.get(turn.room) ?? []), turn])
  for (const [room, turns] of rooms) {
    const low = bands[room]?.end
    const high = bands[room + 1]?.start
    if (low === undefined || high === undefined) continue
    const down = turns.filter((turn) => turn.to > turn.from).sort((a, b) => a.from - b.from)
    const up = turns.filter((turn) => turn.to < turn.from).sort((a, b) => b.from - a.from)
    // Furthest on first: the order that keeps runs from crossing, going down, then going up.
    const ordered = [...down, ...up]
    const width = Math.max(0, high - low - 2 * CHANNEL_MARGIN)
    const step = ordered.length < 2 ? 0 : Math.min(CHANNEL_SPACING, width / (ordered.length - 1))
    const middle = (low + high) / 2
    ordered.forEach((turn, index) => {
      turn.channel = middle + ((ordered.length - 1) / 2 - index) * step
    })
  }

  const routes = new Map<string, Route>()
  for (const plan of plans) {
    const points: Point[] = [plan.stations[0]!]
    let mid: Point | null = null
    plan.turns.forEach((turn, index) => {
      if (turn !== null) {
        points.push(at(turn.channel, turn.from), at(turn.channel, turn.to))
        if (mid === null) mid = at(turn.channel, (turn.from + turn.to) / 2)
      }
      points.push(plan.stations[index + 1]!)
    })
    // On its middle lane when it has some, a gap between two cards; else on its first turn; else halfway along.
    const inner = plan.stations.slice(1, -1)
    if (inner.length > 0) mid = inner[Math.floor((inner.length - 1) / 2)]!
    if (mid === null) mid = { x: (plan.start.x + plan.end.x) / 2, y: (plan.start.y + plan.end.y) / 2 }
    routes.set(plan.edge.id, { d: roundedPath(points), mid, start: plan.start, end: plan.end, points })
  }

  // Back, or within one column: a curve out of its side and back in, as before any channel.
  for (const [id, { out, into }] of curves) {
    const edge = out.edge
    const start = anchor(rects.get(edge.from)!, out.side, offsets.get(out) ?? 0)
    const end = anchor(rects.get(edge.to)!, into.side, offsets.get(into) ?? 0)
    const gap = Math.hypot(end.x - start.x, end.y - start.y)
    const reach = out.side === into.side ? 56 + gap * 0.2 : Math.max(40, gap * 0.45)
    const { c1, c2 } = curve(start, NORMAL[out.side], end, NORMAL[into.side], reach)
    // The curve as a line of short steps, for its label to slide along.
    const bezier = (t: number): Point => {
      const u = 1 - t
      return {
        x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
        y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
      }
    }
    routes.set(id, {
      d: `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`,
      mid: bezier(0.5),
      start,
      end,
      points: Array.from({ length: 25 }, (_, index) => bezier(index / 24)),
    })
  }
  return routes
}

// --- The labels ----------------------------------------------------------------------

/** A label to place: its edge's route, and its size. */
export type LabelRequest = { id: string; route: Pick<Route, "mid" | "points">; width: number; height: number }

/** Every this many pixels along its line, a place a label may take. */
const LABEL_STEP = 6
/** Room kept between a label and a card, or another label. */
const LABEL_CLEARANCE = 4

/** A label's width as the page sets it, 11 px Hanken Grotesk or IBM Plex Mono, its padding and border: a little over, never under. */
export function labelWidth(text: string, mono: boolean): number {
  return Math.ceil(text.length * (mono ? 6.7 : 6.3)) + 16
}
export const LABEL_HEIGHT = 18

/** Every point along a line, `step` apart, from its first point to its last. */
export function alongLine(points: readonly Point[], step = LABEL_STEP): Point[] {
  const found: Point[] = []
  for (let index = 1; index < points.length; index += 1) {
    const p = points[index - 1]!
    const q = points[index]!
    const length = Math.hypot(q.x - p.x, q.y - p.y)
    const count = Math.max(1, Math.ceil(length / step))
    for (let k = index === 1 ? 0 : 1; k <= count; k += 1) found.push({ x: p.x + ((q.x - p.x) * k) / count, y: p.y + ((q.y - p.y) * k) / count })
  }
  return found
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * Where each label goes: on its own line, at the place nearest the one it
 * prefers that covers no card and no label placed before it, with a little
 * room around; where none is free, the place that covers the least. In the
 * order asked, so that the labels always shown, the routes', keep their
 * place when a card's lit ones come.
 */
export function placeLabels(requests: readonly LabelRequest[], cards: Iterable<Rect>): Map<string, Point> {
  const obstacles = [...cards].map((rect) => ({
    x: rect.x - LABEL_CLEARANCE,
    y: rect.y - LABEL_CLEARANCE,
    width: rect.width + 2 * LABEL_CLEARANCE,
    height: rect.height + 2 * LABEL_CLEARANCE,
  }))
  const placed: Rect[] = []
  const found = new Map<string, Point>()
  for (const request of requests) {
    const candidates = alongLine(request.route.points)
    if (candidates.length === 0) candidates.push(request.route.mid)
    let best = request.route.mid
    let bestCost = Infinity
    for (const point of candidates) {
      const box = { x: point.x - request.width / 2, y: point.y - request.height / 2, width: request.width, height: request.height }
      let covered = 0
      for (const obstacle of obstacles) covered += overlap(box, obstacle)
      for (const other of placed) covered += overlap(box, { x: other.x - LABEL_CLEARANCE, y: other.y - LABEL_CLEARANCE, width: other.width + 2 * LABEL_CLEARANCE, height: other.height + 2 * LABEL_CLEARANCE })
      // What it covers weighs far more than how far it slid.
      const cost = covered * 1000 + Math.hypot(point.x - request.route.mid.x, point.y - request.route.mid.y)
      if (cost < bestCost) {
        bestCost = cost
        best = point
      }
    }
    found.set(request.id, best)
    placed.push({ x: best.x - request.width / 2, y: best.y - request.height / 2, width: request.width, height: request.height })
  }
  return found
}

// --- The words -----------------------------------------------------------------------

/** What an edge's state is called, in the legend and in a sheet. */
export const EDGE_WORDS: Record<EdgeState, string> = {
  open: "Open now",
  seen: "Seen before",
  routed: "Routed by Caddy",
  declared: "Declared",
}

/**
 * A lit edge's badge on the canvas, short enough to sit between two columns:
 * "2 open", "19h ago", the variable that declares it, "routed". The whole
 * sentence is the sheet's and the badge's tooltip.
 */
export function edgeBadge(edge: Pick<MapEdge, "state" | "open" | "seen" | "declared">, now: number): { text: string; mono: boolean } {
  if (edge.state === "declared" && edge.declared.length > 0) {
    const first = edge.declared[0] === "start" ? "command line" : edge.declared[0]!
    return { text: edge.declared.length > 1 ? `${first} +${edge.declared.length - 1}` : first, mono: edge.declared[0] !== "start" }
  }
  return { text: edgeShort(edge, now).toLowerCase(), mono: false }
}

/** An edge's state in a word or two, beside the other end in a sheet: "3 open", "19h ago", "Routed", "Declared". */
export function edgeShort(edge: Pick<MapEdge, "state" | "open" | "seen">, now: number): string {
  switch (edge.state) {
    case "open":
      return `${edge.open} open`
    case "seen":
      return ago(now - (edge.seen ?? now))
    case "routed":
      return "Routed"
    case "declared":
      return "Declared"
  }
}

/**
 * What declares an edge, in words: "Declared in API_URL", "Every service
 * gets INFERENCE_URL", "Declared on its command line". Null for one only seen.
 */
export function declaredLine(edge: Pick<MapEdge, "declared" | "shared">): string | null {
  if (edge.declared.length === 0) return null
  const variables = edge.declared.filter((name) => name !== "start")
  const parts: string[] = []
  if (variables.length > 0) parts.push(`${edge.shared ? "Every service gets" : "Declared in"} ${variables.join(", ")}`)
  if (edge.declared.includes("start")) parts.push(parts.length === 0 ? "Declared on its command line" : "on its command line")
  return parts.join(", and ")
}

/** An edge in a few words: "3 connections open", "Last seen 2h ago", "Declared in API_URL", "Routed by Caddy". */
export function edgeLine(edge: Pick<MapEdge, "state" | "open" | "seen" | "declared" | "shared">, now: number): string {
  const declared = declaredLine(edge)
  switch (edge.state) {
    case "open":
      return plural(edge.open, "connection") + " open"
    case "seen":
      return `Last seen ${ago(now - (edge.seen ?? now))}`
    case "routed":
      return "Routed by Caddy, no connection seen yet"
    case "declared":
      return declared ?? (edge.shared ? "May reach it" : "Declared")
  }
}

/** A route's label: its paths, or every path the others leave. */
export function routeLabel(routes: readonly string[]): string {
  return routes.length === 0 ? "All other paths" : routes.join(" ")
}

/** A service's state on the map: its word and tone, quiet when fine, as the Services table says it. */
export function nodeState(service: SiteService): ServiceState | null {
  const state =
    service.kind === "scheduled"
      ? scheduledWord(service)
      : service.service === null
        ? { tone: "error" as Tone, label: "Not loaded" }
        : serviceWord(service.service.active, service.service.subState)
  if (state.tone !== "ok") return state
  if (service.listening === false) return { tone: "error", label: `Nothing listens on ${service.port}` }
  const restarts = restartsLabel(service.service?.restarts ?? null)
  if (restarts !== null) return { tone: "attention", label: restarts }
  return null
}

/** What a service's kind is, in a few words under its name. */
export function kindLabel(service: SiteService): string {
  if (service.backup !== null) return "Database"
  if (service.kind === "worker") return "Background"
  if (service.kind === "scheduled") return "Scheduled"
  return service.internal ? "Internal server" : "Server"
}

/** One quiet line of figures after its memory: its share of a core, how long it has run; its runs, for a scheduled one. */
export function figuresLine(service: SiteService, now: number): string[] {
  const unit = service.service
  if (service.kind === "scheduled") {
    const runs = runLines(service, now)
    return [runs.last?.text, runs.next].filter((text): text is string => text !== null && text !== undefined)
  }
  if (unit === null || unit.active !== "active") return []
  // Its memory goes first, as a ring and its figure: memoryReading.
  const figures: string[] = []
  if (unit.cpuShare !== null) figures.push(`${computeCpuShare(unit.cpuShare)} CPU`)
  if (unit.since !== null) figures.push(`up ${ago(now - unit.since).replace(/ ago$/, "")}`)
  return figures
}

/** A scheduled service's schedule, as words when systemd has a shorthand for it, as written otherwise. */
export function scheduleLabel(service: SiteService): { text: string; mono: boolean } | null {
  if (service.schedule === null) return null
  const words = scheduleWords(service.schedule.expression)
  return words === null ? { text: service.schedule.expression, mono: true } : { text: words, mono: false }
}
