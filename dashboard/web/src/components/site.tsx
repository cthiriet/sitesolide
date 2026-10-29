import { useMemo, type ReactNode } from "react"
import { Check, ChevronRight, ChevronsUpDown, SearchX } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { WithSnapshot, PageBody, EmptyState, PageHeader, Panel } from "@/components/page"
import type { HistoryFilter } from "@/lib/history"
import { isPerson } from "@/lib/identity"
import { pageTitle, siteUrl, type Section } from "@/lib/pages"
import { headerState, kindLine, siteDiscrepancies } from "@/lib/site-card"
import type { ServiceState } from "@/lib/sites"
import { TONE_DOT, TONE_TEXT } from "@/lib/tones"
import type { Discrepancy, ProjectView, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's level: what a section reads of it, the breadcrumb up to it, the
 * switcher that moves from one site to another, and the page shared by its
 * sections. A section does not write its own version of any of them.
 */

// --- What a section reads ----------------------------------------------------------

export type SiteData = {
  /** The site in the snapshot; null if it is not there, or before the first snapshot. */
  site: Site | null
  discrepancies: Discrepancy[]
  /** The steward's project; null until it has been read, or if it does not list it. */
  project: ProjectView | null
}

export function useSite(slug: string): SiteData {
  const { snapshot, secrets } = useData()
  return useMemo(() => {
    const site = snapshot?.sites.find((candidate) => candidate.slug === slug) ?? null
    return {
      site,
      discrepancies: snapshot === null ? [] : siteDiscrepancies(snapshot.discrepancies, slug),
      project: secrets.projects?.find((project) => project.slug === slug) ?? null,
    }
  }, [snapshot, secrets.projects, slug])
}

/**
 * A site's state for the switcher, the same as under its title: quiet when
 * fine, null then, its word and its tone otherwise.
 */
function useSiteStates(): { slug: string; state: ServiceState | null }[] {
  const { snapshot } = useData()
  return useMemo(() => {
    if (snapshot === null) return []
    return snapshot.sites
      .map((site) => ({ slug: site.slug, state: headerState(site, siteDiscrepancies(snapshot.discrepancies, site.slug)) }))
      .sort((a, b) => a.slug.localeCompare(b.slug, "en"))
  }, [snapshot])
}

// --- The switcher ------------------------------------------------------------------

/**
 * Moving from one site to another without going back through the home page, in
 * the same section: one site's Secrets lead to another's. The sites by name,
 * a state dot on those in trouble alone; the current one ticked. Every entry
 * is a real link.
 */
function SiteMenu({ slug, section }: { slug: string; section: Section }) {
  const states = useSiteStates()
  return (
    <DropdownMenuContent align="start" className="max-h-[min(28rem,var(--available-height))] w-64">
      <DropdownMenuGroup>
        <DropdownMenuLabel>Switch site</DropdownMenuLabel>
        {states.map((state) => {
          const current = state.slug === slug
          return (
            <DropdownMenuItem
              key={state.slug}
              render={<InternalLink href={siteUrl(state.slug, section)} aria-current={current ? "page" : undefined} />}
              className="h-9 gap-2.5"
            >
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", state.state !== null && TONE_DOT[state.state.tone])} />
              <span className="min-w-0 flex-1 truncate">{state.slug}</span>
              {state.state !== null && <span className="sr-only">, {state.state.label}</span>}
              {current && <Check aria-hidden="true" className="text-muted-foreground" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

/**
 * The current site in the sidebar, on the card surface: its name, then what
 * it is when fine, "App", and its state in its tone otherwise, "Restarting,
 * 3 errors", with the switcher behind it. Collapsed, the sidebar keeps only
 * its initial, with the state dot while it is in trouble.
 */
export function SidebarSitePicker({ slug, section }: { slug: string; section: Section }) {
  const { snapshot } = useData()
  const { site, discrepancies } = useSite(slug)
  const state = site === null ? null : headerState(site, discrepancies)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={`${slug}, switch site`}
            className="h-auto min-h-12 gap-2.5 rounded-lg border bg-card py-2 shadow-raised hover:bg-card data-popup-open:bg-card group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none"
          />
        }
      >
        <span
          aria-hidden="true"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-tile text-sm font-semibold text-secondary-foreground uppercase shadow-[inset_0_1px_0_var(--tile-hi),inset_0_0_0_1px_var(--border)]"
        >
          {slug.charAt(0)}
          {state !== null && (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card",
                TONE_DOT[state.tone],
              )}
            />
          )}
        </span>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate font-semibold">{slug}</span>
          <span className={cn("truncate text-xs", state === null ? "text-muted-foreground" : TONE_TEXT[state.tone])}>
            {site === null ? (snapshot === null ? "Loading" : "Not on this server") : state === null ? kindLine(site).text : state.label}
          </span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="ml-auto text-muted-foreground" />
      </DropdownMenuTrigger>
      <SiteMenu slug={slug} section={section} />
    </DropdownMenu>
  )
}

/** The switcher on a phone, beside the title: the sidebar is not there. */
function HeaderSitePicker({ slug, section }: { slug: string; section: Section }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch site, ${slug} now`}
            className="-ml-1 size-9 shrink-0 text-muted-foreground hover:text-foreground md:hidden"
          />
        }
      >
        <ChevronsUpDown />
      </DropdownMenuTrigger>
      <SiteMenu slug={slug} section={section} />
    </DropdownMenu>
  )
}

// --- The breadcrumb ----------------------------------------------------------------

const BREADCRUMB_LINK =
  "rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

/**
 * The path up to the section, above its title: all sites, then the site when
 * the section is not its Overview. A structure that says where you are, not a
 * decoration: every piece is a link.
 */
function SiteBreadcrumb({ slug, section }: { slug: string; section: Section }) {
  return (
    <nav aria-label="Breadcrumb" className="-ml-0.5">
      <ol className="flex min-w-0 items-center gap-1 text-xs">
        <li>
          <InternalLink href="/" className={BREADCRUMB_LINK}>
            All sites
          </InternalLink>
        </li>
        {section !== "overview" && (
          <li className="flex min-w-0 items-center gap-1">
            <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            <InternalLink href={siteUrl(slug)} className={cn(BREADCRUMB_LINK, "truncate")}>
              {slug}
            </InternalLink>
          </li>
        )}
      </ol>
    </nav>
  )
}

// --- The shared page ---------------------------------------------------------------

/**
 * A site's section: the header with its breadcrumb and, on a phone, the
 * switcher; then the body, which only receives a site the snapshot knows. An
 * unknown slug says so, in every section, with the way back. `intro`,
 * `history` and `actions` are the page header's (components/page.tsx).
 */
export function SitePage({
  slug,
  section,
  count,
  intro,
  history,
  description,
  actions,
  skeleton,
  wide = false,
  children,
}: {
  slug: string
  section: Section
  count?: ReactNode
  intro?: ReactNode
  history?: HistoryFilter
  description?: ReactNode
  actions?: ReactNode
  skeleton: ReactNode
  /** The whole width beside the sidebar, for a canvas, rather than the reading measure. */
  wide?: boolean
  children: (site: Site) => ReactNode
}) {
  const { identity } = useData()
  return (
    <>
      <PageHeader
        title={pageTitle({ name: "site", slug, section })}
        breadcrumb={<SiteBreadcrumb slug={slug} section={section} />}
        afterTitle={<HeaderSitePicker slug={slug} section={section} />}
        count={count}
        intro={intro}
        history={history}
        description={description}
        actions={actions}
        wide={wide}
      />
      <PageBody className={cn(wide && "max-w-none")}>
        <WithSnapshot skeleton={skeleton}>
          {(snapshot) => {
            const site = snapshot.sites.find((candidate) => candidate.slug === slug)
            if (site === undefined) {
              // A person sees their projects alone: one they hold no role on reads as absent, and whom to ask.
              const person = isPerson(identity)
              return (
                <Panel>
                  <EmptyState
                    icon={SearchX}
                    title={person ? `No project named ${slug} that you have a role on` : `No site named "${slug}"`}
                    action={
                      <InternalLink href="/" className={cn(buttonVariants({ variant: "outline" }), "max-md:h-10")}>
                        {person ? "Show your projects" : "Show all sites"}
                      </InternalLink>
                    }
                  >
                    {person
                      ? `If someone sent you this link, ask the owner or an Admin of ${slug} to add you.`
                      : "The server doesn't serve a folder by that name. It may have been removed, or the link is mistyped."}
                  </EmptyState>
                </Panel>
              )
            }
            return children(site)
          }}
        </WithSnapshot>
      </PageBody>
    </>
  )
}
