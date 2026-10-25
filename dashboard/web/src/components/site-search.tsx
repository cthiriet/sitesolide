import { SEGMENTED, Segment } from "@/components/page"
import { FILTERS, type SiteFilter } from "@/lib/sites"
import { cn } from "@/lib/utils"

/** The search field every list shares, kept here under its old address for the home page. */
export { SearchField } from "@/components/filter-bar"

/**
 * The inventory's filters, one at a time, each with the number of sites it
 * would keep under the current search. Toggle buttons rather than a radio
 * group: each one reads and is reached on its own, with the keyboard as with a
 * finger. The chosen filter takes the grey of the sidebar's current page.
 *
 * `filters` are those offered, Platform last and only when it has projects
 * (`offeredFilters`). On a phone five share one row; six take two rows of
 * three, where one row would leave each too narrow for its word.
 */
export function SiteFilterChips({
  filters,
  value,
  counts,
  onValue,
}: {
  filters: typeof FILTERS
  value: SiteFilter
  counts: Record<SiteFilter, number>
  onValue: (filter: SiteFilter) => void
}) {
  return (
    <div
      role="group"
      aria-label="Filter sites"
      className={cn(SEGMENTED, "grid w-full gap-0.5 sm:inline-flex sm:w-auto", filters.length > 5 ? "grid-cols-3" : "grid-cols-5")}
    >
      {filters.map((filter) => (
        <Segment
          key={filter.key}
          selected={filter.key === value}
          title={filter.description}
          onClick={() => onValue(filter.key)}
          className="min-w-0 gap-1.5 px-1.5 sm:px-2.5"
        >
          {filter.label}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{counts[filter.key]}</span>
        </Segment>
      ))}
    </div>
  )
}
