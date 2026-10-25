import { describe, expect, test } from "bun:test"
import { activeFilters, isNarrowed, listSearch, narrowList, readListState, shownLabel, type ListSpec } from "../src/lib/list-state"
import { rowClickOutcome } from "../src/lib/rows"

const SPEC: ListSpec = { facets: { access: ["public", "restricted"], kind: ["static", "app"] }, sorts: ["issues", "name"] }

type Row = { slug: string; access: string; kind: string }
const ROWS: Row[] = [
  { slug: "cms", access: "restricted", kind: "app" },
  { slug: "calendar", access: "restricted", kind: "app" },
  { slug: "bookshop", access: "public", kind: "static" },
  { slug: "lab", access: "public", kind: "app" },
]
const MATCHERS = {
  search: (row: Row, query: string) => row.slug.includes(query.trim()),
  facets: { access: (row: Row) => row.access, kind: (row: Row) => row.kind },
}

describe("the address", () => {
  test("reads the search, each facet and the sort, the default when it says nothing", () => {
    expect(readListState(new URLSearchParams("q=ca&access=restricted"), SPEC)).toEqual({
      query: "ca",
      facets: { access: "restricted", kind: null },
      sort: "issues",
    })
  })

  test("drops a value or a sort the list does not offer", () => {
    expect(readListState(new URLSearchParams("access=secret&sort=size"), SPEC)).toEqual({ query: "", facets: { access: null, kind: null }, sort: "issues" })
  })

  test("writes the list's own parameters, keeps every other one, never the default sort", () => {
    const state = { query: "ca", facets: { access: "restricted", kind: null }, sort: "issues" }
    expect(listSearch("s=cms&token=t1", state, SPEC)).toBe("?s=cms&token=t1&q=ca&access=restricted")
    expect(listSearch("q=ca&sort=name", { query: "", facets: { access: null, kind: null }, sort: "issues" }, SPEC)).toBe("")
    expect(listSearch("", { query: "", facets: { access: null, kind: "app" }, sort: "name" }, SPEC)).toBe("?kind=app&sort=name")
  })
})

describe("what the bar says", () => {
  test("narrowed by a search or a facet, never by the sort", () => {
    const sorted = { query: "", facets: { access: null, kind: null }, sort: "name" }
    expect(isNarrowed(sorted)).toBe(false)
    expect(activeFilters({ ...sorted, query: "cal", facets: { access: "public", kind: "app" } })).toBe(3)
  })

  test("3 of 14 only while narrowed", () => {
    expect(shownLabel(3, 14, true)).toBe("3 of 14")
    expect(shownLabel(14, 14, false)).toBeNull()
  })
})

describe("narrowing, and the facets' counts", () => {
  test("keeps the rows every chosen facet and the search keep, in their order", () => {
    const state = { query: "", facets: { access: "restricted", kind: null }, sort: null }
    expect(narrowList(ROWS, state, MATCHERS).rows.map((row) => row.slug)).toEqual(["cms", "calendar"])
  })

  test("a facet's counts are taken under the search and the other facets, never under itself", () => {
    const state = { query: "", facets: { access: "restricted", kind: "app" }, sort: null }
    const { counts } = narrowList(ROWS, state, MATCHERS)
    // Access counts under Kind: App alone; Kind counts under Access: Restricted alone.
    expect(counts.access).toEqual({ restricted: 2, public: 1 })
    expect(counts.kind).toEqual({ app: 2 })
  })

  test("the search narrows every count", () => {
    const { rows, counts } = narrowList(ROWS, { query: "ca", facets: { access: null, kind: null }, sort: null }, MATCHERS)
    expect(rows.map((row) => row.slug)).toEqual(["calendar"])
    expect(counts.access).toEqual({ restricted: 1 })
  })
})

describe("a click on a row", () => {
  const click = (partial: Partial<Parameters<typeof rowClickOutcome>[0]> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...partial,
  })

  test("is the row's, except on what acts by itself and at the end of a selection", () => {
    expect(rowClickOutcome(click(), false, "")).toBe("page")
    expect(rowClickOutcome(click(), true, "")).toBeNull()
    expect(rowClickOutcome(click(), false, "cms.test-zone.invalid")).toBeNull()
    expect(rowClickOutcome(click({ ctrlKey: true }), false, "")).toBe("tab")
  })
})
