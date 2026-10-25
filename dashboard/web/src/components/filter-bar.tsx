import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as FieldKeyEvent, type RefObject } from "react"
import { ArrowDownUp, Check, ChevronDown, Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useNavigation } from "@/components/navigation"
import { Count } from "@/components/page"
import {
  CLEAR_FROM,
  activeFilters,
  isNarrowed,
  listSearch,
  readListState,
  shownLabel,
  type ListSpec,
  type ListState,
} from "@/lib/list-state"
import { searchShortcut } from "@/lib/search"
import { cn } from "@/lib/utils"

/**
 * The one filter row, under the page header: the search on the left, with
 * its "/" key; a button per facet, each a menu of single choices with their
 * icons and live counts, which reads "Access: Restricted" with an x once
 * chosen; "Clear filters" from two; on the right "3 of 14" while narrowed,
 * and the sort. Below 36 rem of its own width, the search and one *Filter*
 * button with a count, which opens a bottom sheet holding the facets and the
 * sort. Shown from `FILTER_BAR_FROM` items, always on Sites and Activity.
 *
 * The state is the address's (`useListState`, lib/list-state.ts).
 */

// --- The state ---------------------------------------------------------------------

export type ListControls = ListState & {
  setQuery: (query: string) => void
  setFacet: (name: string, value: string | null) => void
  setSort: (sort: string) => void
  /** The search and every facet back to all; the sort stays. */
  clear: () => void
  /** The search and the facets chosen. */
  active: number
  narrowed: boolean
}

/**
 * A list's search, facets and sort, read from the address and written back
 * to it, replacing the entry. `spec` is a module constant: the values each
 * facet accepts, the sorts, the default first.
 */
export function useListState(spec: ListSpec): ListControls {
  const { params, path, navigate } = useNavigation()
  const query = params.toString()
  const state = useMemo(() => readListState(new URLSearchParams(query), spec), [query, spec])
  const write = (next: ListState) => navigate(`${path}${listSearch(query, next, spec)}`, { replace: true })
  return {
    ...state,
    active: activeFilters(state),
    narrowed: isNarrowed(state),
    setQuery: (value) => write({ ...state, query: value }),
    setFacet: (name, value) => write({ ...state, facets: { ...state.facets, [name]: value } }),
    setSort: (sort) => write({ ...state, sort }),
    clear: () => write({ ...state, query: "", facets: Object.fromEntries(Object.keys(state.facets).map((name) => [name, null])) }),
  }
}

// --- The search --------------------------------------------------------------------

/**
 * A list's search field. `/` brings focus to it from anywhere in the page,
 * except while typing; Escape clears the field, then, with the field empty,
 * gives focus back to the element that had it before `/`.
 */
export function SearchField({
  field,
  value,
  onValue,
  label = "Search sites",
  placeholder = label,
  className,
}: {
  field: RefObject<HTMLInputElement | null>
  value: string
  onValue: (value: string) => void
  /** What a screen reader hears: "Search tokens". */
  label?: string
  placeholder?: string
  className?: string
}) {
  const id = useId()
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const element = field.current
      // Under the sign-in overlay the page is `inert`: the field does not take focus there.
      if (element === null || element.closest("[inert]") !== null) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!searchShortcut(event, target)) return
      event.preventDefault()
      const active = document.activeElement
      previousFocus.current = active instanceof HTMLElement && active !== document.body ? active : null
      element.focus()
      element.select()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [field])

  function handleFieldKeyDown(event: FieldKeyEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return
    // Chrome already clears a `search` field on Escape, but without giving focus back: the page decides on its own.
    event.preventDefault()
    if (value !== "") return onValue("")
    const previous = previousFocus.current
    previousFocus.current = null
    if (previous !== null && previous.isConnected) previous.focus()
    else event.currentTarget.blur()
  }

  function clear() {
    onValue("")
    field.current?.focus()
  }

  return (
    <div role="search" className={cn("relative", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={field}
        id={id}
        type="search"
        value={value}
        onChange={(event) => onValue(event.target.value)}
        onKeyDown={handleFieldKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-keyshortcuts="/"
        className="peer h-10 pr-9 pl-8 md:h-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value === "" ? (
        // A reminder for the mouse and the physical keyboard: not on a narrow screen, nor on a touch screen.
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 hidden h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-sm border border-input bg-card px-1.5 font-mono text-[0.6875rem] text-muted-foreground peer-focus:opacity-0 sm:pointer-fine:inline-flex"
        >
          /
        </kbd>
      ) : (
        <span className="absolute inset-y-0 right-1 flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            onClick={clear}
            className="text-muted-foreground hover:text-foreground max-md:size-8"
          >
            <X />
          </Button>
        </span>
      )}
    </div>
  )
}

// --- The bar -----------------------------------------------------------------------

/** One choice of a facet: its value in the address, its word, its icon (the rows' own), and how many it would show. */
export type FacetOption = {
  value: string
  label: string
  icon?: LucideIcon
  /** The icon's colour class, when it carries a state: `text-destructive` for a mismatch. */
  tone?: string
  count?: number
}

export type Facet = {
  /** Its parameter, one of the spec's facets. */
  name: string
  /** Its button's word: "Access". */
  label: string
  options: readonly FacetOption[]
  /** The word for no choice, the menu's first item. */
  all?: string
}

export type SortOption = { value: string; label: string }

/** A facet's menu items, the legend of the rows' icons: icon, word, count. */
function FacetItems({ facet, value, onValue }: { facet: Facet; value: string | null; onValue: (value: string | null) => void }) {
  return (
    <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onValue(next === "" ? null : String(next))}>
      <DropdownMenuRadioItem value="" className="h-9">
        {facet.all ?? "All"}
      </DropdownMenuRadioItem>
      {facet.options.map((option) => {
        const Icon = option.icon
        return (
          <DropdownMenuRadioItem key={option.value} value={option.value} className="h-9 gap-2">
            {Icon !== undefined && <Icon aria-hidden="true" className={cn("size-4", option.tone ?? "text-muted-foreground")} />}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.count !== undefined && (
              <span className={cn("pl-3 text-xs tabular-nums", option.count === 0 ? "text-faint" : "text-muted-foreground")}>{option.count}</span>
            )}
          </DropdownMenuRadioItem>
        )
      })}
    </DropdownMenuRadioGroup>
  )
}

/** The look of the bar's buttons: the field's height, quiet words, the chosen value in `strong`. */
const BAR_BUTTON = "h-10 font-normal text-secondary-foreground md:h-9"

function FacetButton({ facet, value, onValue }: { facet: Facet; value: string | null; onValue: (value: string | null) => void }) {
  const chosen = value === null ? null : (facet.options.find((option) => option.value === value) ?? null)
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className={cn(BAR_BUTTON, chosen !== null && "rounded-r-none border-r-0 pr-2")}
            aria-label={chosen === null ? `${facet.label}: all` : `${facet.label}: ${chosen.label}`}
          />
        }
      >
        {chosen === null ? (
          facet.label
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">{facet.label}:</span>
            <span className="font-medium text-strong">{chosen.label}</span>
          </span>
        )}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{facet.label}</DropdownMenuLabel>
          <FacetItems facet={facet} value={value} onValue={onValue} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  if (chosen === null) return menu
  return (
    <span className="inline-flex">
      {menu}
      <Button
        variant="outline"
        size="icon"
        aria-label={`Clear ${facet.label}`}
        onClick={() => onValue(null)}
        className="size-10 rounded-l-none text-muted-foreground hover:text-foreground md:size-9"
      >
        <X />
      </Button>
    </span>
  )
}

function SortButton({ sorts, value, onValue }: { sorts: readonly SortOption[]; value: string | null; onValue: (value: string) => void }) {
  const current = sorts.find((sort) => sort.value === value) ?? sorts[0]
  if (current === undefined) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className={cn(BAR_BUTTON, "px-2.5")} aria-label={`Sort: ${current.label}`} />}
      >
        <ArrowDownUp aria-hidden="true" className="text-muted-foreground" />
        {current.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current.value} onValueChange={(next) => onValue(String(next))}>
            {sorts.map((sort) => (
              <DropdownMenuRadioItem key={sort.value} value={sort.value} className="h-9">
                {sort.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A choice in the phone's sheet: a 44 px row, the icon and the count of the menu, ticked when chosen. */
function SheetChoice({
  chosen,
  onPress,
  icon: Icon,
  tone,
  count,
  children,
}: {
  chosen: boolean
  onPress: () => void
  icon?: LucideIcon
  tone?: string
  count?: number
  children: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onPress}
      className={cn(
        "flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        chosen ? "bg-highlight font-medium text-strong" : "hover:bg-muted",
      )}
    >
      {Icon !== undefined && <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone ?? "text-muted-foreground")} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
      <Check aria-hidden="true" className={cn("size-4 shrink-0 text-primary", !chosen && "invisible")} />
    </button>
  )
}

/** On a phone: the facets and the sort in a bottom sheet, applied as they are chosen. */
function FilterSheet({
  open,
  onOpenChange,
  list,
  facets,
  sorts,
  showLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  list: ListControls
  facets: readonly Facet[]
  sorts: readonly SortOption[]
  showLabel: string
}) {
  const chosenFacets = facets.filter((facet) => (list.facets[facet.name] ?? null) !== null).length
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[90svh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="text-heading">Filters</SheetTitle>
          <SheetDescription className="sr-only">Applied as you choose them.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 overflow-y-auto px-2 py-3">
          {facets.map((facet) => {
            const value = list.facets[facet.name] ?? null
            return (
              <div key={facet.name} role="radiogroup" aria-label={facet.label} className="grid gap-0.5">
                <p className="px-2 pb-1 mono-label">{facet.label}</p>
                <SheetChoice chosen={value === null} onPress={() => list.setFacet(facet.name, null)}>
                  {facet.all ?? "All"}
                </SheetChoice>
                {facet.options.map((option) => (
                  <SheetChoice
                    key={option.value}
                    chosen={value === option.value}
                    onPress={() => list.setFacet(facet.name, option.value)}
                    icon={option.icon}
                    tone={option.tone}
                    count={option.count}
                  >
                    {option.label}
                  </SheetChoice>
                ))}
              </div>
            )
          })}
          {sorts.length > 1 && (
            <div role="radiogroup" aria-label="Sort" className="grid gap-0.5">
              <p className="px-2 pb-1 mono-label">Sort</p>
              {sorts.map((sort) => (
                <SheetChoice key={sort.value} chosen={(list.sort ?? sorts[0]!.value) === sort.value} onPress={() => list.setSort(sort.value)}>
                  {sort.label}
                </SheetChoice>
              ))}
            </div>
          )}
        </div>
        <SheetFooter className="flex-row justify-between border-t">
          <Button variant="ghost" disabled={chosenFacets === 0} onClick={list.clear} className="h-11">
            Clear filters
          </Button>
          <Button onClick={() => onOpenChange(false)} className="h-11 px-4">
            {showLabel}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The filter row. `list` is `useListState`'s; `facets` carry their counts,
 * which the page computes (`narrowList`); `shown` and `total` give "3 of
 * 14" while narrowed; `noun` the phone sheet's button, "Show 3 sites".
 */
export function FilterBar({
  list,
  facets = [],
  sorts = [],
  shown,
  total,
  noun,
  search = { label: "Search" },
  className,
}: {
  list: ListControls
  facets?: readonly Facet[]
  sorts?: readonly SortOption[]
  shown: number
  total: number
  /** What the rows are, singular and plural: { one: "site", many: "sites" }. */
  noun: { one: string; many: string }
  search?: { label: string; placeholder?: string }
  className?: string
}) {
  const field = useRef<HTMLInputElement>(null)
  const [sheet, setSheet] = useState(false)
  const count = shownLabel(shown, total, list.narrowed)
  const chosenFacets = facets.filter((facet) => (list.facets[facet.name] ?? null) !== null).length
  const showLabel = `Show ${shown} ${shown === 1 ? noun.one : noun.many}`
  const offersMore = facets.length > 0 || sorts.length > 1

  return (
    <div className={cn("@container/filters", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          field={field}
          value={list.query}
          onValue={list.setQuery}
          label={search.label}
          placeholder={search.placeholder ?? search.label}
          className="min-w-0 flex-1 @xl/filters:w-60 @xl/filters:flex-none"
        />

        {/* At its full width: a button per facet. */}
        <div className="hidden flex-wrap items-center gap-2 @xl/filters:flex">
          {facets.map((facet) => (
            <FacetButton
              key={facet.name}
              facet={facet}
              value={list.facets[facet.name] ?? null}
              onValue={(value) => list.setFacet(facet.name, value)}
            />
          ))}
          {list.active >= CLEAR_FROM && (
            <Button variant="ghost" onClick={list.clear} className={cn(BAR_BUTTON, "px-2.5 text-muted-foreground hover:text-foreground")}>
              Clear filters
            </Button>
          )}
        </div>

        <div className="hidden items-center gap-1 @xl/filters:ml-auto @xl/filters:flex">
          {count !== null && (
            <p role="status" className="px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {count}
            </p>
          )}
          {sorts.length > 1 && <SortButton sorts={sorts} value={list.sort} onValue={list.setSort} />}
        </div>

        {/* Narrow: one button for the facets and the sort, a sheet behind it. */}
        {offersMore && (
          <Button
            variant="outline"
            onClick={() => setSheet(true)}
            aria-label={chosenFacets === 0 ? "Filter" : `Filter, ${chosenFacets} chosen`}
            className={cn(BAR_BUTTON, "@xl/filters:hidden")}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filter
            {chosenFacets > 0 && <Count className="ml-0.5">{chosenFacets}</Count>}
          </Button>
        )}
        {count !== null && (
          <p className="w-full text-xs text-muted-foreground tabular-nums @xl/filters:hidden">{count}</p>
        )}
      </div>

      {offersMore && <FilterSheet open={sheet} onOpenChange={setSheet} list={list} facets={facets} sorts={sorts} showLabel={showLabel} />}
    </div>
  )
}
