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
import { WithSnapshot, PageBody, EmptyState, PageHeader, Panel, Status } from "@/components/page"
import { siteGuests } from "@/lib/invitations"
import type { Guest } from "@/lib/guests"
import { SECTIONS, siteUrl, type Section } from "@/lib/pages"
import { siteDiscrepancies, siteState } from "@/lib/site-card"
import { TONE_DOT } from "@/lib/tones"
import type { Discrepancy, ProjectView, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's level: what a section reads of it, the breadcrumb up to it, the
 * switcher that moves from one site to another, and the page shared by the four
 * sections. A section does not write its own version of any of them.
 */

// --- What a section reads ----------------------------------------------------------

export type SiteData = {
  /** The site in the snapshot; null if it is not there, or before the first snapshot. */
  site: Site | null
  discrepancies: Discrepancy[]
  /** The steward's project; null until it has been read, or if it does not list it. */
  project: ProjectView | null
  /** Its guest accesses, active then expired; null until the list has been read. */
  guests: { active: Guest[]; expired: Guest[] } | null
}

export function useSite(slug: string): SiteData {
  const { snapshot, secrets, guests, now } = useData()
  const list = guests.list
  return useMemo(() => {
    const site = snapshot?.sites.find((candidate) => candidate.slug === slug) ?? null
    return {
      site,
      discrepancies: snapshot === null ? [] : siteDiscrepancies(snapshot.discrepancies, slug),
      project: secrets.projects?.find((project) => project.slug === slug) ?? null,
      guests: site !== null && list.state === "ready" ? siteGuests(list.guests, site.address, now) : null,
    }
  }, [snapshot, secrets.projects, list, slug, now])
}

/** A site's state in one word and one tone, for the switcher and the sidebar: the same as under its title. */
export function useSiteStates(): { slug: string; tone: ReturnType<typeof siteState>["tone"]; label: string }[] {
  const { snapshot } = useData()
  return useMemo(() => {
    if (snapshot === null) return []
    return snapshot.sites
      .map((site) => ({ slug: site.slug, ...siteState(site, siteDiscrepancies(snapshot.discrepancies, site.slug)) }))
      .sort((a, b) => a.slug.localeCompare(b.slug, "en"))
  }, [snapshot])
}

// --- The switcher ------------------------------------------------------------------

/**
 * Moving from one site to another without going back through the home page, in
 * the same section: one site's Secrets lead to another's. The sites by name,
 * each with its state dot; the current one ticked. Every entry is a real link.
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
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[state.tone])} />
              <span className="min-w-0 flex-1 truncate">{state.slug}</span>
              <span className="sr-only">, {state.label}</span>
              {current && <Check aria-hidden="true" className="text-muted-foreground" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

/**
 * The current site in the sidebar: its name and its state, with the switcher
 * behind it. Collapsed, the sidebar keeps only its initial, with the state dot.
 */
export function SidebarSitePicker({ slug, section }: { slug: string; section: Section }) {
  const { snapshot } = useData()
  const { site, discrepancies } = useSite(slug)
  const state = site === null ? null : siteState(site, discrepancies)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={`${slug}, switch site`}
            className="h-auto min-h-12 gap-2.5 border bg-sidebar-accent py-2 hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
          />
        }
      >
        <span
          aria-hidden="true"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-display text-sm font-semibold uppercase"
        >
          {slug.charAt(0)}
          {state !== null && (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar-accent",
                TONE_DOT[state.tone],
              )}
            />
          )}
        </span>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate font-semibold">{slug}</span>
          <span className="truncate text-xs text-muted-foreground">
            {state === null ? (snapshot === null ? "Loading" : "Not on this server") : state.label}
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
  "rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"

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

/** A link from a panel to a section of the same site: *Manage ›*. */
export function SectionLink({
  slug,
  section,
  children = "Manage",
}: {
  slug: string
  section: Section
  children?: ReactNode
}) {
  return (
    <InternalLink
      href={siteUrl(slug, section)}
      className={cn(
        buttonVariants({ variant: "ghost", size: "sm" }),
        "-mr-2 text-muted-foreground hover:text-foreground max-md:h-9",
      )}
    >
      {children}
      <ChevronRight aria-hidden="true" />
    </InternalLink>
  )
}

// --- The shared page ---------------------------------------------------------------

/** A section's title, except Overview, which carries the slug. */
function sectionTitle(slug: string, section: Section): string {
  return section === "overview" ? slug : (SECTIONS.find((entry) => entry.section === section)?.title ?? slug)
}

/**
 * A site's section: the header with its breadcrumb and, on a phone, the
 * switcher; then the body, which only receives a site the snapshot knows. An
 * unknown slug says so, in every section, with the way back.
 */
export function SitePage({
  slug,
  section,
  count,
  description,
  actions,
  skeleton,
  children,
}: {
  slug: string
  section: Section
  count?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  skeleton: ReactNode
  children: (site: Site) => ReactNode
}) {
  return (
    <>
      <PageHeader
        title={sectionTitle(slug, section)}
        breadcrumb={<SiteBreadcrumb slug={slug} section={section} />}
        afterTitle={<HeaderSitePicker slug={slug} section={section} />}
        count={count}
        description={description}
        actions={actions}
      />
      <PageBody>
        <WithSnapshot skeleton={skeleton}>
          {(snapshot) => {
            const site = snapshot.sites.find((candidate) => candidate.slug === slug)
            if (site === undefined) {
              return (
                <Panel>
                  <EmptyState
                    icon={SearchX}
                    title={`No site named "${slug}"`}
                    action={
                      <InternalLink href="/" className={cn(buttonVariants({ variant: "outline" }), "max-md:h-10")}>
                        Show all sites
                      </InternalLink>
                    }
                  >
                    The server doesn't serve a folder by that name. It may have been removed, or the link is mistyped.
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

/** A site's state under its title, a dot and a word: "Running, 1 warning". */
export function SiteState({ site, discrepancies }: { site: Site; discrepancies: readonly Discrepancy[] }) {
  const state = siteState(site, discrepancies)
  return (
    <Status
      tone={state.tone}
      className={cn(state.tone === "ok" || state.tone === "neutral" ? "text-foreground" : "font-medium")}
    >
      {state.label}
    </Status>
  )
}
