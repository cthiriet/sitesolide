import { useEffect, useMemo, useRef, useState } from "react"
import { CircleCheck, Globe, SearchX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { MachinePlate, PlateSkeleton } from "@/components/gauge"
import { InternalLink } from "@/components/navigation"
import {
  WithSnapshot,
  PageBody,
  EmptyState,
  SeverityIcon,
  PageHeader,
  Panel,
  PanelSkeleton,
} from "@/components/page"
import { SearchField, SiteFilterChips } from "@/components/site-search"
import { SiteList } from "@/components/sites"
import { activeByHost } from "@/lib/invitations"
import { siteUrl } from "@/lib/pages"
import { searchAnnouncement, filterSites, countLabel, queryWords } from "@/lib/search"
import { withSecrets } from "@/lib/secrets"
import { countFilters, filterByKind, FILTERS, sitesCaption, sortSites, type SiteFilter } from "@/lib/sites"
import type { Discrepancy, Snapshot, Site } from "@/lib/types"
import { worstSeverities, sortDiscrepancies } from "@/lib/verdict"

/** The announcement of the result count waits for typing to settle: one per keystroke would be read in a burst. */
const ANNOUNCE_MS = 750

/**
 * The search and the filter survive a round trip to a site, for the length of
 * the page's session: the home page unmounts when you enter a site, and coming
 * back to a list reset to zero would mean typing everything again. A reload
 * starts over from the whole list.
 */
const memory: { query: string; filter: SiteFilter } = { query: "", filter: "all" }

/** What a filter says when it keeps no site, with no search in progress. */
const EMPTY_FILTER: Record<Exclude<SiteFilter, "all">, string> = {
  issues: "No site has an refusal",
  apps: "No apps on this server",
  static: "No static sites on this server",
  portal: "No site is behind the portal",
}

/**
 * The discrepancies, errors first. When the panel is wide enough, the messages
 * line up in a column behind the longest slug, through a subgrid; otherwise the
 * slug goes above its message. A known slug leads to the site.
 */
function IssuesPanel({ discrepancies, sites }: { discrepancies: readonly Discrepancy[]; sites: readonly Site[] }) {
  const known = new Set(sites.map((site) => site.slug))
  return (
    <Panel title="Issues" count={discrepancies.length} full>
      {discrepancies.length === 0 ? (
        <EmptyState icon={CircleCheck} title="No issues" compact>
          Every site runs the way its repository asks.
        </EmptyState>
      ) : (
        <div className="@container">
          <ul className="grid divide-y @lg:grid-cols-[auto_auto_minmax(0,1fr)]">
            {sortDiscrepancies(discrepancies).map((discrepancy, index) => {
              const slug = discrepancy.slug
              return (
                <li
                  key={`${slug}-${index}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-4 py-2.5 @lg:col-span-3 @lg:grid-cols-subgrid"
                >
                  <SeverityIcon severity={discrepancy.severity} label className="row-span-2 mt-0.5 @lg:row-span-1" />
                  <div className="col-start-2 @lg:pr-3">
                    {slug === null ? (
                      <span className="font-medium">Server</span>
                    ) : known.has(slug) ? (
                      <InternalLink
                        href={siteUrl(slug)}
                        className="rounded-sm font-medium underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {slug}
                      </InternalLink>
                    ) : (
                      <span className="font-medium">{slug}</span>
                    )}
                  </div>
                  <p className="col-start-2 text-sm text-pretty @lg:col-start-3 @lg:row-start-1">{discrepancy.message}</p>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Panel>
  )
}

function Inventory({ snapshot }: { snapshot: Snapshot }) {
  const { now, secretsBySite, guests } = useData()
  const announce = useAnnounce()
  const [query, setQueryState] = useState(memory.query)
  const [filter, setFilterState] = useState<SiteFilter>(memory.filter)
  const field = useRef<HTMLInputElement>(null)

  function setQuery(value: string) {
    memory.query = value
    setQueryState(value)
  }
  function setFilter(value: SiteFilter) {
    memory.filter = value
    setFilterState(value)
  }

  const list = guests.list
  const worst = useMemo(() => worstSeverities(snapshot.discrepancies), [snapshot.discrepancies])
  const activeGuests = useMemo(
    () => (list.state === "ready" ? activeByHost(list.guests, now) : null),
    [list, now],
  )
  // Enriched once per read: the search and the rows read the same objects.
  const sites = useMemo(() => withSecrets(snapshot.sites, secretsBySite), [snapshot.sites, secretsBySite])
  const found = useMemo(() => filterSites(sites, query), [sites, query])
  const counts = useMemo(() => countFilters(found, worst), [found, worst])
  const visible = useMemo(() => sortSites(filterByKind(found, filter, worst), worst), [found, filter, worst])

  const words = queryWords(query)
  const key = `${filter} ${words.join(" ")}`
  const search = words.length > 0
  const narrowed = search || filter !== "all"
  const displayedQuery = query.trim().replace(/\s+/g, " ")

  // Only a change of search or filter is announced, never the first render nor a refresh.
  const announced = useRef(key)
  useEffect(() => {
    if (key === announced.current) return
    const timer = window.setTimeout(() => {
      announced.current = key
      announce(searchAnnouncement(visible.length, sites.length, narrowed))
    }, ANNOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [key, visible.length, sites.length, narrowed, announce])

  function clear() {
    setQuery("")
    field.current?.focus()
  }

  if (sites.length === 0) {
    return (
      <Panel>
        <EmptyState icon={Globe} title="No sites on this server">
          Nothing is served from /srv/sites yet. A site appears here after its first sitesolide deploy.
        </EmptyState>
      </Panel>
    )
  }

  const filterLabel = FILTERS.find((candidate) => candidate.key === filter)?.label ?? ""

  return (
    <section aria-label="Sites" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchField field={field} value={query} onValue={setQuery} className="w-full sm:w-64" />
        <SiteFilterChips value={filter} counts={counts} onValue={setFilter} />
        <p className="text-xs text-muted-foreground tabular-nums sm:ml-auto">
          {countLabel(visible.length, sites.length, narrowed)}
          {visible.length > 1 && ", issues first"}
        </p>
      </div>

      {visible.length > 0 ? (
        <SiteList
          sites={visible}
          worst={worst}
          activeGuests={activeGuests}
          now={now}
          caption={sitesCaption(filter, search ? displayedQuery : null)}
        />
      ) : search ? (
        <Panel>
          <EmptyState
            icon={SearchX}
            title={`No sites match "${displayedQuery}"`}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={clear} className="max-md:h-10">
                  Clear search
                </Button>
                {filter !== "all" && (
                  <Button variant="ghost" onClick={() => setFilter("all")} className="max-md:h-10">
                    Search all sites
                  </Button>
                )}
              </div>
            }
          >
            {filter === "all"
              ? "Search looks at names, descriptions, addresses, ports, access, service states and secret variable names."
              : `Only sites under ${filterLabel} were searched.`}
          </EmptyState>
        </Panel>
      ) : (
        <Panel>
          <EmptyState
            icon={SearchX}
            title={filter === "all" ? "No sites match" : EMPTY_FILTER[filter]}
            action={
              <Button variant="outline" onClick={() => setFilter("all")} className="max-md:h-10">
                Show all sites
              </Button>
            }
          />
        </Panel>
      )}
    </section>
  )
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-6">
      <PlateSkeleton />
      <PanelSkeleton lines={3} />
      <div aria-hidden="true" className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-10 w-full rounded-lg sm:h-9 sm:w-64" />
        <Skeleton className="h-10 w-full rounded-lg sm:h-9 sm:w-96" />
      </div>
      <PanelSkeleton lines={8} title={false} />
    </div>
  )
}

/**
 * The home page: the machine, what is wrong, then each site as one row that
 * leads to it, its pills included (restart pending, portal and active guests).
 * A search and filters, the sites in discrepancy at the top.
 */
export function HomePage() {
  const { snapshot } = useData()
  return (
    <>
      <PageHeader title="Sites" count={snapshot?.sites.length} />
      <PageBody>
        <WithSnapshot skeleton={<HomeSkeleton />}>
          {(snapshot) => (
            <>
              <MachinePlate snapshot={snapshot} />
              <IssuesPanel discrepancies={snapshot.discrepancies} sites={snapshot.sites} />
              <Inventory snapshot={snapshot} />
            </>
          )}
        </WithSnapshot>
      </PageBody>
    </>
  )
}
