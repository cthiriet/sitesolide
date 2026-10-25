/**
 * A list's search, facets and sort, as its address carries them, and what
 * they keep. Pure, tested by tests/list-state.test.ts; the FilterBar
 * (components/filter-bar.tsx) draws them and `useListState` reads and writes
 * the address.
 *
 *   /?q=cal&access=restricted&kind=app&sort=name
 *
 * The address is the state: a reload, a shared link and Back give the same
 * list. Writing it replaces the history entry rather than adding one, so
 * that Back leaves the page instead of undoing a keystroke. Parameters the
 * list does not own, a site's `s`, a sheet's `token`, are kept as they are.
 */
import type { SearchParams } from "./pages"

/** What a list accepts from its address. */
export type ListSpec = {
  /** Each facet, by its parameter, and the values it accepts. Single choice: one value or none. */
  facets?: Readonly<Record<string, readonly string[]>>
  /** The orders it offers, its default first. The default is never written into the address. */
  sorts?: readonly string[]
}

export type ListState = {
  /** The search, as typed. */
  query: string
  /** Each facet's chosen value, null for all. */
  facets: Readonly<Record<string, string | null>>
  /** The order chosen, the spec's first when the address says nothing. Null when the list offers none. */
  sort: string | null
}

/** The search's parameter. */
export const QUERY_PARAM = "q"
/** The sort's parameter. */
export const SORT_PARAM = "sort"

/** A FilterBar is shown from this many items, except where the page always needs it (Sites, Activity). */
export const FILTER_BAR_FROM = 10

/** A typed search is cut here: no list is searched for more. */
const MAX_QUERY = 200

/**
 * The state an address asks for. A facet value or a sort the list does not
 * offer is dropped, rather than kept as a filter that keeps nothing.
 */
export function readListState(params: SearchParams, spec: ListSpec): ListState {
  const facets: Record<string, string | null> = {}
  for (const [name, values] of Object.entries(spec.facets ?? {})) {
    const value = params.get(name)
    facets[name] = value !== null && values.includes(value) ? value : null
  }
  const sorts = spec.sorts ?? []
  const asked = params.get(SORT_PARAM)
  const sort = sorts.length === 0 ? null : asked !== null && sorts.includes(asked) ? asked : sorts[0]!
  return { query: (params.get(QUERY_PARAM) ?? "").slice(0, MAX_QUERY), facets, sort }
}

/**
 * The query string for a new state, `?` included, or "" when nothing is
 * left: the list's own parameters rewritten, every other one of `current`,
 * the address's query, kept in its place.
 */
export function listSearch(current: string, state: ListState, spec: ListSpec): string {
  const next = new URLSearchParams(current)
  const query = state.query.slice(0, MAX_QUERY)
  if (query.trim() === "") next.delete(QUERY_PARAM)
  else next.set(QUERY_PARAM, query)
  for (const name of Object.keys(spec.facets ?? {})) {
    const value = state.facets[name] ?? null
    if (value === null) next.delete(name)
    else next.set(name, value)
  }
  const sorts = spec.sorts ?? []
  if (state.sort === null || state.sort === sorts[0]) next.delete(SORT_PARAM)
  else next.set(SORT_PARAM, state.sort)
  const text = next.toString()
  return text === "" ? "" : `?${text}`
}

/** How many filters narrow the list: the search, and each facet chosen. The sort narrows nothing. */
export function activeFilters(state: ListState): number {
  const facets = Object.values(state.facets).filter((value) => value !== null).length
  return facets + (state.query.trim() === "" ? 0 : 1)
}

/** Is the list narrowed? Then, and only then, the bar says "3 of 14". */
export function isNarrowed(state: ListState): boolean {
  return activeFilters(state) > 0
}

/** "3 of 14" while narrowed, nothing otherwise: the page header already counts the whole list. */
export function shownLabel(shown: number, total: number, narrowed: boolean): string | null {
  return narrowed ? `${shown} of ${total}` : null
}

/** "Clear filters" is offered from two filters: one has its own x. */
export const CLEAR_FROM = 2

/** What a list's rows answer to: the search, and each facet's value for a row (several when a row belongs to more than one). */
export type ListMatchers<Row> = {
  search: (row: Row, query: string) => boolean
  facets?: Readonly<Record<string, (row: Row) => string | readonly string[]>>
}

const valuesOf = (value: string | readonly string[]): readonly string[] => (typeof value === "string" ? [value] : value)

/**
 * The rows the state keeps, in their order, and each facet value's count,
 * faceted: a facet's counts are taken under the search and the other facets,
 * never under itself, so that its menu says what choosing each value would
 * show.
 */
export function narrowList<Row>(
  rows: readonly Row[],
  state: ListState,
  matchers: ListMatchers<Row>,
): { rows: Row[]; counts: Record<string, Record<string, number>> } {
  const facets = Object.entries(matchers.facets ?? {})
  const searched = state.query.trim() === "" ? [...rows] : rows.filter((row) => matchers.search(row, state.query))
  const keeps = (row: Row, except: string | null) =>
    facets.every(([name, of]) => {
      const chosen = state.facets[name] ?? null
      return name === except || chosen === null || valuesOf(of(row)).includes(chosen)
    })
  const counts: Record<string, Record<string, number>> = {}
  for (const [name, of] of facets) {
    const tally: Record<string, number> = {}
    for (const row of searched) {
      if (!keeps(row, name)) continue
      for (const value of valuesOf(of(row))) tally[value] = (tally[value] ?? 0) + 1
    }
    counts[name] = tally
  }
  return { rows: searched.filter((row) => keeps(row, null)), counts }
}
