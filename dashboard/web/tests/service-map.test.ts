import { describe, expect, test } from "bun:test"
import {
  buildMap,
  columns,
  alongLine,
  declaredLine,
  edgeBadge,
  edgeLine,
  edgeShort,
  frameOf,
  layout,
  labelWidth,
  nodeState,
  placeLabels,
  roundedPath,
  routeEdges,
  type MapEdge,
  type Rect,
  type Size,
} from "../src/lib/service-map"
import type { SiteLink, SiteService } from "../src/lib/types"
import { service, site, siteService } from "./factory"

const NOW = 1_756_400_000_000

function link(partial: Partial<SiteLink> & Pick<SiteLink, "from" | "to">): SiteLink {
  return { open: 0, seen: null, declared: [], shared: false, ...partial }
}

/** A project of three tiers: a public web front and its API, a database behind the API, a worker and a nightly job. */
function playground(links: SiteLink[] = [], partial: Parameters<typeof site>[0] = {}) {
  const services: SiteService[] = [
    siteService({ name: "web", unit: "lab", main: true, port: 3047, listening: true }),
    siteService({ name: "api", unit: "lab.api", port: 3048, listening: true, routes: ["/v1/*"] }),
    siteService({ name: "db", unit: "lab.db", port: 3050, listening: true, internal: true, backup: "pg" }),
    siteService({ name: "queue", unit: "lab.queue", kind: "worker", internal: true }),
  ]
  return site({ slug: "lab", services, links, ...partial })
}

const ids = (edges: readonly MapEdge[]) => edges.map((edge) => edge.id)

describe("the graph", () => {
  test("visitors reach each public service by its routes, Caddy's configuration saying so before any connection is seen", () => {
    const map = buildMap(playground())
    expect(map.nodes.map((node) => node.id)).toEqual(["visitors", "lab", "lab.api", "lab.db", "lab.queue"])
    expect(map.nodes.find((node) => node.id === "lab.db")!.kind).toBe("database")
    const visitors = map.edges.filter((edge) => edge.from === "visitors")
    expect(visitors.map((edge) => [edge.to, edge.state, edge.label])).toEqual([
      ["lab", "routed", "All other paths"],
      ["lab.api", "routed", "/v1/*"],
    ])
  })

  test("the one service that takes every path, with no files before it, says so", () => {
    const map = buildMap(site({ services: [siteService({ unit: "calendar", main: true, port: 3040 })] }))
    expect(map.edges.map((edge) => edge.label)).toEqual(["Every path"])
  })

  test("a link is open, seen before, or only declared, and Caddy's carries its count", () => {
    const map = buildMap(
      playground([
        link({ from: "caddy", to: "lab", open: 3, seen: NOW }),
        link({ from: "lab.api", to: "lab.db", open: 4, seen: NOW }),
        link({ from: "lab.queue", to: "lab.db", seen: NOW - 3_600_000 }),
        link({ from: "lab", to: "lab.api", declared: ["API_URL"] }),
      ]),
    )
    const state = (id: string) => map.edges.find((edge) => edge.id === id)?.state
    expect(state("visitors>lab")).toBe("open")
    expect(map.edges.find((edge) => edge.id === "visitors>lab")!.open).toBe(3)
    expect(state("lab.api>lab.db")).toBe("open")
    expect(state("lab.queue>lab.db")).toBe("seen")
    expect(state("lab>lab.api")).toBe("declared")
  })

  test("a variable every service receives is left out once some service is seen using it, and always from a database", () => {
    const shared = (from: string) => link({ from, to: "lab.api", declared: ["API_URL"], shared: true })
    const unseen = buildMap(playground([shared("lab"), shared("lab.db"), shared("lab.queue")]))
    expect(ids(unseen.edges).filter((id) => id.endsWith(">lab.api") && !id.startsWith("visitors"))).toEqual(["lab>lab.api", "lab.queue>lab.api"])
    const seen = buildMap(playground([shared("lab"), shared("lab.queue"), link({ from: "lab.queue", to: "lab.api", open: 1, seen: NOW, declared: ["API_URL"], shared: true })]))
    expect(ids(seen.edges).filter((id) => id.endsWith(">lab.api") && !id.startsWith("visitors"))).toEqual(["lab.queue>lab.api"])
  })

  test("what leaves the machine: from the services seen taking it, or else from every one that may, a database aside", () => {
    const network = { outbound: false, egress: ["api.example.org"], connectors: ["slack"] }
    const declared = buildMap(playground([], { network }))
    expect(ids(declared.edges).filter((id) => id.endsWith(">egress"))).toEqual(["lab>egress", "lab.api>egress", "lab.queue>egress"])
    expect(declared.edges.filter((edge) => edge.to === "egress").every((edge) => edge.state === "declared" && edge.shared)).toBe(true)
    const seen = buildMap(playground([link({ from: "lab.api", to: "egress", open: 1, seen: NOW })], { network }))
    expect(ids(seen.edges).filter((id) => id.endsWith(">egress"))).toEqual(["lab.api>egress"])
    expect(seen.nodes.map((node) => node.id)).toContain("connectors")
  })

  test("a project that serves no page has no visitors, and starts its columns at its services", () => {
    const map = buildMap(playground([], { headless: true }))
    expect(map.nodes.some((node) => node.id === "visitors")).toBe(false)
    expect(Math.min(...map.nodes.map((node) => node.layer))).toBe(0)
  })

  test("another process seen calling a service gets a node of its own, named no further", () => {
    const map = buildMap(playground([link({ from: "outside", to: "lab.db", open: 1, seen: NOW })]))
    expect(map.nodes.find((node) => node.id === "outside")!.layer).toBe(0)
    expect(ids(map.edges)).toContain("outside>lab.db")
  })
})

describe("the columns", () => {
  test("who calls a service stands to its left; what leaves the machine comes last", () => {
    const map = buildMap(
      playground([link({ from: "lab", to: "lab.api", open: 1, seen: NOW }), link({ from: "lab.api", to: "lab.db", open: 1, seen: NOW })], {
        network: { outbound: true, egress: [], connectors: [] },
      }),
    )
    const layer = (id: string) => map.nodes.find((node) => node.id === id)!.layer
    expect([layer("visitors"), layer("lab"), layer("lab.api"), layer("lab.db"), layer("lab.queue"), layer("internet")]).toEqual([0, 1, 2, 3, 1, 4])
  })

  test("a loop does not hang the layering", () => {
    const map = buildMap(playground([link({ from: "lab", to: "lab.api", open: 1, seen: NOW }), link({ from: "lab.api", to: "lab", open: 1, seen: NOW })]))
    expect(map.nodes.every((node) => Number.isFinite(node.layer))).toBe(true)
  })

  test("an edge crossing a column takes a lane through it", () => {
    const map = buildMap(playground([link({ from: "lab", to: "lab.api", open: 1, seen: NOW })]))
    // Visitors to the API cross the web front's column.
    const lanes = columns(map).flat().filter((slot) => slot.node === null)
    expect(lanes.map((slot) => slot.id)).toEqual(["visitors>lab.api@1"])
  })
})

describe("the places", () => {
  const size = (): Size => ({ width: 200, height: 100 })

  test("columns left to right, each centred on the tallest, and a lane's point between the cards", () => {
    const map = buildMap(playground([link({ from: "lab", to: "lab.api", open: 1, seen: NOW })]))
    const { places, lanes, width } = layout(map, size)
    expect(places.get("visitors")!.x).toBe(0)
    expect(places.get("lab")!.x).toBe(304)
    expect(places.get("lab.api")!.x).toBe(608)
    expect(width).toBe(808)
    const lane = lanes.get("visitors>lab.api")!
    expect(lane).toHaveLength(1)
    expect(lane[0]!.x).toBe(404)
  })

  test("a dragged card keeps its place, and its edges leave their lanes", () => {
    const map = buildMap(playground([link({ from: "lab", to: "lab.api", open: 1, seen: NOW })]))
    const { places, lanes } = layout(map, size, false, { "lab.api": { x: 900, y: -40 }, gone: { x: 1, y: 1 } })
    expect(places.get("lab.api")).toEqual({ x: 900, y: -40 })
    expect(places.has("gone")).toBe(false)
    expect(lanes.has("visitors>lab.api")).toBe(false)
  })

  test("top to bottom, rows instead of columns", () => {
    const map = buildMap(playground())
    const { places } = layout(map, size, true)
    expect(places.get("visitors")!.y).toBe(0)
    expect(places.get("lab")!.y).toBeGreaterThan(100)
  })

  test("the frame holds the services, with room for its title above them, or below laid top to bottom", () => {
    const map = buildMap(playground())
    const rects = new Map<string, Rect>([
      ["visitors", { x: 0, y: 0, width: 100, height: 50 }],
      ["lab", { x: 200, y: 0, width: 100, height: 50 }],
      ["lab.api", { x: 200, y: 100, width: 100, height: 50 }],
    ])
    expect(frameOf(map, rects)).toEqual({ x: 180, y: -52, width: 140, height: 222 })
    expect(frameOf(map, rects, true)).toEqual({ x: 180, y: -20, width: 140, height: 222 })
  })
})

describe("the edges' paths", () => {
  const rects = new Map<string, Rect>([
    ["a", { x: 0, y: 0, width: 100, height: 40 }],
    ["b", { x: 300, y: 0, width: 100, height: 40 }],
    ["c", { x: 300, y: 100, width: 100, height: 40 }],
  ])
  const edge = (from: string, to: string): MapEdge => ({
    id: `${from}>${to}`,
    from,
    to,
    state: "open",
    open: 1,
    seen: NOW,
    declared: [],
    shared: false,
    routes: null,
    label: null,
  })

  const grid = { bands: [{ start: 0, end: 100 }, { start: 300, end: 400 }], bandOf: new Map([["a", 0], ["b", 1], ["c", 1]]) }

  test("forward, from the right side to the left one, ends sharing a side spread in the order of their other end", () => {
    const routes = routeEdges([edge("a", "b"), edge("a", "c")], rects, false, grid)
    expect(routes.get("a>b")!.start).toEqual({ x: 100, y: 14 })
    expect(routes.get("a>c")!.start).toEqual({ x: 100, y: 26 })
    expect(routes.get("a>b")!.end).toEqual({ x: 300, y: 20 })
    expect(routes.get("a>b")!.d.startsWith("M 100 14 L")).toBe(true)
  })

  test("each turn takes a channel of its own between the columns, the one starting higher turning further on", () => {
    const routes = routeEdges([edge("a", "b"), edge("a", "c")], rects, false, grid)
    // a to b goes down from y 14 to 20, a to c from y 26 to 120: two channels 14 px apart around the room's middle, 200.
    // Where it turns across: its first bend's corner.
    const channel = (id: string) => Number(/Q ([\d.]+) /.exec(routes.get(id)!.d)![1])
    expect([channel("a>b"), channel("a>c")]).toEqual([207, 193])
    // The label on its turn across, halfway down it.
    expect(routes.get("a>c")!.mid).toEqual({ x: 193, y: 73 })
  })

  test("its bends are rounded, a run that turns nothing is one line", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }])).toBe("M 0 0 L 100 0")
    expect(roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 80 }])).toBe("M 0 0 L 40 0 Q 50 0 50 10 L 50 80")
  })

  test("a card dragged out of its column turns halfway", () => {
    const routes = routeEdges([edge("a", "c")], rects)
    expect(routes.get("a>c")!.d).toBe("M 100 20 L 190 20 Q 200 20 200 30 L 200 110 Q 200 120 210 120 L 300 120")
  })

  test("within one column, out of the right side and back in by it", () => {
    const routes = routeEdges([edge("b", "c")], rects)
    expect(routes.get("b>c")!.start.x).toBe(400)
    expect(routes.get("b>c")!.end.x).toBe(400)
  })

  test("through its lanes, its label on the middle one", () => {
    const wide = new Map<string, Rect>([...rects, ["b", { x: 600, y: 0, width: 100, height: 40 }]])
    const routes = routeEdges([edge("a", "b")], wide, false, {
      lanes: new Map([["a>b", [{ x: 350, y: 80 }]]]),
      bands: [{ start: 0, end: 100 }, { start: 300, end: 400 }, { start: 600, end: 700 }],
      bandOf: new Map([["a", 0], ["b", 2]]),
    })
    expect(routes.get("a>b")!.mid).toEqual({ x: 350, y: 80 })
    // Down to the lane in the first room, up from it in the second: four bends.
    expect(routes.get("a>b")!.d.split(" Q ").length).toBe(5)
  })
})

describe("the words", () => {
  test("an edge in a few words, and what declares it", () => {
    const base = { open: 0, seen: null, declared: [] as string[], shared: false }
    expect(edgeLine({ ...base, state: "open", open: 3, seen: NOW }, NOW)).toBe("3 connections open")
    expect(edgeLine({ ...base, state: "seen", seen: NOW - 2 * 3_600_000 }, NOW)).toBe("Last seen 2h ago")
    expect(edgeShort({ ...base, state: "seen", seen: NOW - 2 * 3_600_000 }, NOW)).toBe("2h ago")
    expect(edgeLine({ ...base, state: "declared", declared: ["API_URL"] }, NOW)).toBe("Declared in API_URL")
    expect(declaredLine({ declared: ["INFERENCE_URL"], shared: true })).toBe("Every service gets INFERENCE_URL")
    expect(declaredLine({ declared: ["start"], shared: false })).toBe("Declared on its command line")
    expect(declaredLine({ declared: ["start", "API_URL"], shared: false })).toBe("Declared in API_URL, and on its command line")
    expect(declaredLine({ declared: [], shared: false })).toBeNull()
  })

  test("a service's state, quiet when fine", () => {
    expect(nodeState(siteService({ port: 3047, listening: true }))).toBeNull()
    expect(nodeState(siteService({ port: 3047, listening: false }))).toEqual({ tone: "error", label: "Nothing listens on 3047" })
    expect(nodeState(siteService({ service: service({ active: "activating", subState: "auto-restart" }) }))).toEqual({ tone: "error", label: "Restarting" })
    expect(nodeState(siteService({ service: null }))).toEqual({ tone: "error", label: "Not loaded" })
  })
})

describe("the labels", () => {
  const line = { mid: { x: 150, y: 50 }, points: [{ x: 0, y: 50 }, { x: 300, y: 50 }] }

  test("points along a line, a step apart, its ends included", () => {
    const points = alongLine([{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }], 6)
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 6 },
      { x: 12, y: 12 },
    ])
  })

  test("a label stays where it prefers when nothing is there", () => {
    expect(placeLabels([{ id: "a", route: line, width: 40, height: 18 }], [])).toEqual(new Map([["a", { x: 150, y: 50 }]]))
  })

  test("it slides along its line off a card that covers its place", () => {
    const card = { x: 120, y: 30, width: 60, height: 40 }
    const at = placeLabels([{ id: "a", route: line, width: 40, height: 18 }], [card]).get("a")!
    expect(at.y).toBe(50)
    // Clear of the card and its 4 px of room: its half width, 20, past 180 + 4, or before 120 - 4.
    expect(at.x >= 204 || at.x <= 96).toBe(true)
  })

  test("two labels on one line do not cover each other, the first keeping its place", () => {
    const where = placeLabels(
      [
        { id: "a", route: line, width: 60, height: 18 },
        { id: "b", route: line, width: 60, height: 18 },
      ],
      [],
    )
    expect(where.get("a")).toEqual({ x: 150, y: 50 })
    expect(Math.abs(where.get("b")!.x - 150)).toBeGreaterThanOrEqual(64)
  })

  test("a lit edge's badge is short enough for the room between two columns", () => {
    const base = { open: 0, seen: null, declared: [] as string[] }
    expect(edgeBadge({ ...base, state: "open", open: 2, seen: NOW }, NOW)).toEqual({ text: "2 open", mono: false })
    expect(edgeBadge({ ...base, state: "seen", seen: NOW - 19 * 3_600_000 }, NOW)).toEqual({ text: "19h ago", mono: false })
    expect(edgeBadge({ ...base, state: "declared", declared: ["API_URL", "start"] }, NOW)).toEqual({ text: "API_URL +1", mono: true })
    expect(edgeBadge({ ...base, state: "declared", declared: ["start"] }, NOW)).toEqual({ text: "command line", mono: false })
    expect(edgeBadge({ ...base, state: "routed" }, NOW)).toEqual({ text: "routed", mono: false })
    // The room between two columns, less the room kept on either side.
    expect(labelWidth("19h ago", false)).toBeLessThan(104 - 2 * 16)
  })
})
