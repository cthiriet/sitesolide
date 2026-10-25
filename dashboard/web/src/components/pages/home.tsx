import { useMemo, useState } from "react"
import { Globe, SearchX, createLucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useData } from "@/components/data"
import { FilterBar, useListState, type Facet, type ListControls } from "@/components/filter-bar"
import { MachineStrip, StripSkeleton } from "@/components/gauge"
import { accessEntry, kindEntry } from "@/components/legend"
import { Banner, EmptyState, InlineEmpty, PageBody, PageHeader, Panel, PanelSkeleton, WithSnapshot } from "@/components/page"
import { SiteList } from "@/components/sites"
import { isPerson } from "@/lib/identity"
import { mayOpen } from "@/lib/pages"
import { FRESH_TITLE } from "@/lib/search"
import { withSecrets } from "@/lib/secrets"
import {
  BANNERS_SHOWN,
  PLATFORM_FACET,
  SITES_LIST,
  SITE_SORTS,
  figureOf,
  narrowSites,
  narrowedSites,
  rowState,
  rowlessIssues,
  sitesCaption,
  sortSites,
  type ListedSite,
  type Narrowed,
  type RowState,
} from "@/lib/site-list"
import type { Discrepancy, Snapshot } from "@/lib/types"
import { worstSeverities } from "@/lib/verdict"

/** The Platform item of the Kind menu has no icon of its own in a row: a blank keeps its word in line with the others. */
const NoIcon = createLucideIcon("no-icon", [])

const NOUN = { one: "site", many: "sites" }

/**
 * The discrepancies no row carries, the server's own and an orphaned
 * fragment's: a banner each, errors first, two of them and then "Show 3
 * more". Nothing at all when there is none: the verdict says All clear.
 */
function RowlessIssues({ issues }: { issues: readonly Discrepancy[] }) {
  const [all, setAll] = useState(false)
  if (issues.length === 0) return null
  const shown = all ? issues : issues.slice(0, BANNERS_SHOWN)
  const hidden = issues.length - shown.length
  return (
    <section aria-label="Server issues" className="grid justify-items-stretch gap-2">
      {shown.map((issue, index) => (
        <Banner key={`${issue.slug}-${index}`} tone={issue.severity === "error" ? "error" : "attention"}>
          <span className="mr-2 font-medium">{issue.slug ?? "Server"}</span>
          {issue.message}
        </Banner>
      ))}
      {issues.length > BANNERS_SHOWN && (
        <Button variant="ghost" size="sm" onClick={() => setAll(!all)} className="-ml-1 justify-self-start text-muted-foreground hover:text-foreground max-md:h-9">
          {all ? "Show fewer" : `Show ${hidden} more`}
        </Button>
      )}
    </section>
  )
}

/** The facets, each value with the rows' own icon, its word and its count: the legend of the rows. */
function siteFacets(narrowed: Narrowed<ListedSite>): Facet[] {
  return [
    {
      name: "access",
      label: "Access",
      options: narrowed.offered.access.map((key) => {
        const entry = accessEntry(key)
        return { value: key, label: entry.facet, icon: entry.icon, tone: entry.tone, count: narrowed.counts.access[key] ?? 0 }
      }),
    },
    {
      name: "kind",
      label: "Kind",
      options: narrowed.offered.kind.map((kind) => {
        const count = narrowed.counts.kind[kind] ?? 0
        if (kind === "platform") return { value: kind, label: PLATFORM_FACET, icon: NoIcon, count }
        const entry = kindEntry(kind)
        return { value: kind, label: entry.facet, icon: entry.icon, count }
      }),
    },
  ]
}

/** What replaces the rows when none is left: one line, and the one action that brings some back. */
function EmptyRows({ list, narrowed }: { list: ListControls; narrowed: Narrowed<ListedSite> }) {
  const query = list.query.trim().replace(/\s+/g, " ")
  const facets = Object.values(list.facets).some((value) => value !== null)
  const link = "h-auto p-0"
  if (narrowed.total === 0 && query === "" && !facets) {
    // The platform's own projects alone, all of them well, which the list leaves out.
    const platform = narrowed.counts.kind.platform ?? 0
    return (
      <InlineEmpty
        icon={Globe}
        action={
          platform > 0 && (
            <Button variant="link" className={link} onClick={() => list.setFacet("kind", "platform")}>
              Show platform projects
            </Button>
          )
        }
      >
        {FRESH_TITLE}. Run sitesolide deploy in a project's folder.
      </InlineEmpty>
    )
  }
  if (query !== "" && narrowed.platformMatches > 0) {
    const matches = narrowed.platformMatches === 1 ? "1 platform project matches" : `${narrowed.platformMatches} platform projects match`
    return (
      <InlineEmpty
        icon={SearchX}
        action={
          <Button variant="link" className={link} onClick={() => list.setFacet("kind", "platform")}>
            Search platform projects
          </Button>
        }
      >
        No sites match "{query}". {matches}.
      </InlineEmpty>
    )
  }
  return (
    <InlineEmpty
      icon={SearchX}
      action={
        <Button variant="link" className={link} onClick={list.clear}>
          {facets ? "Clear filters" : "Clear search"}
        </Button>
      }
    >
      {query === "" ? "No sites match these filters." : `No sites match "${query}".`}
    </InlineEmpty>
  )
}

/** The strip, what has no row, the filter row and the list: what the snapshot lets the page say. */
function Sites({ snapshot, list, narrowed }: { snapshot: Snapshot; list: ListControls; narrowed: Narrowed<ListedSite> }) {
  const { identity } = useData()
  const person = isPerson(identity)
  const worst = useMemo(() => worstSeverities(snapshot.discrepancies), [snapshot.discrepancies])
  const rows = useMemo(() => sortSites(narrowed.rows, list.sort, worst), [narrowed.rows, list.sort, worst])
  const states = useMemo(() => {
    const map = new Map<string, RowState>()
    for (const site of narrowed.rows) {
      const state = rowState(site, snapshot.discrepancies)
      if (state !== null) map.set(site.slug, state)
    }
    return map
  }, [narrowed.rows, snapshot.discrepancies])
  const rowless = useMemo(() => rowlessIssues(snapshot.discrepancies, snapshot.sites), [snapshot.discrepancies, snapshot.sites])
  const which = figureOf(list.sort)

  if (snapshot.sites.length === 0) {
    // A person sees their projects alone: none yet is no word about the server.
    if (person) {
      return (
        <Panel>
          <EmptyState icon={Globe} title="No project of yours yet">
            {identity.create
              ? "You may create projects: create a token on the Tokens page, then run sitesolide deploy in the project's folder. You become its Admin."
              : "A project appears here once an Admin of it, or the owner, gives you a role on it."}
          </EmptyState>
        </Panel>
      )
    }
    return (
      <>
        <MachineStrip snapshot={snapshot} sort={list.sort} onSort={(sort) => list.setSort(list.sort === sort ? SITE_SORTS[0]!.value : sort)} />
        <RowlessIssues issues={rowless} />
        <Panel full>
          <InlineEmpty icon={Globe}>{FRESH_TITLE}. Run sitesolide deploy in a project's folder.</InlineEmpty>
        </Panel>
      </>
    )
  }

  return (
    <>
      {!person && (
        <MachineStrip snapshot={snapshot} sort={list.sort} onSort={(sort) => list.setSort(list.sort === sort ? SITE_SORTS[0]!.value : sort)} />
      )}
      <RowlessIssues issues={rowless} />
      <section aria-label="Sites" className="grid gap-3">
        <FilterBar
          list={{ ...list, narrowed: narrowedSites(list) }}
          facets={siteFacets(narrowed)}
          sorts={SITE_SORTS}
          shown={rows.length}
          total={narrowed.total}
          noun={NOUN}
          search={{ label: "Search sites" }}
        />
        <Panel full>
          <SiteList
            rows={rows}
            states={states}
            which={which}
            caption={sitesCaption(list.sort, list)}
            empty={<EmptyRows list={list} narrowed={narrowed} />}
          />
        </Panel>
      </section>
    </>
  )
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-6">
      <StripSkeleton />
      <div className="grid gap-3">
        <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-10 w-full rounded-lg sm:h-9 sm:w-60" />
          <Skeleton className="hidden h-9 w-24 rounded-lg sm:block" />
          <Skeleton className="hidden h-9 w-20 rounded-lg sm:block" />
        </div>
        <PanelSkeleton lines={10} title={false} />
      </div>
    </div>
  )
}

/**
 * The home page: is anything wrong on the machine, and which site to open.
 * The machine's strip, then what has no row of its own as banners, then
 * every site as one line, the ones in trouble first, each saying its trouble
 * in a word beside its name. The platform's own projects are listed under
 * Kind: Platform, and elsewhere only while they need the owner.
 */
export function HomePage() {
  const { snapshot, identity, secretsBySite } = useData()
  const list = useListState(SITES_LIST)
  // Enriched once per read: the search, the facets and the rows read the same objects.
  const sites = useMemo(() => (snapshot === null ? null : withSecrets(snapshot.sites, secretsBySite)), [snapshot, secretsBySite])
  const worst = useMemo(() => (snapshot === null ? null : worstSeverities(snapshot.discrepancies)), [snapshot])
  const narrowed = useMemo(
    () => (sites === null || worst === null ? null : narrowSites(sites, worst, list)),
    // `list` is rebuilt on every render; what it narrows by is its query, facets and sort.
    [sites, worst, list.query, list.facets],
  )
  return (
    <>
      <PageHeader
        title="Sites"
        count={narrowed?.total}
        intro={
          <>
            <p>
              Every project this server serves, one line each. A site in trouble comes first and says so beside its name, every
              message in that word's tooltip; the server's own issues sit above the list.
            </p>
            <p className="text-muted-foreground">
              Load, memory and disk are ticked at 70 and 90 %. Press Memory or Disk to sort the sites by what each one holds.
            </p>
          </>
        }
        history={mayOpen({ name: "activity" }, identity) ? { type: "deployments" } : undefined}
      />
      <PageBody>
        <WithSnapshot skeleton={<HomeSkeleton />}>
          {(snapshot) => (narrowed === null ? <HomeSkeleton /> : <Sites snapshot={snapshot} list={list} narrowed={narrowed} />)}
        </WithSnapshot>
      </PageBody>
    </>
  )
}
