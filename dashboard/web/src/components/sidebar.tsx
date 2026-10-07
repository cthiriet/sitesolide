import { useMemo } from "react"
import { ChartNoAxesColumn, ChevronLeft, Contact, DatabaseBackup, Gauge, Globe, History, KeyRound, LogOut, PanelLeft, Plug, Share2, ShieldCheck, Users, UsersRound, type LucideIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useData } from "@/components/data"
import { Logo } from "@/components/logo"
import { InternalLink, useNavigation } from "@/components/navigation"
import { SidebarSitePicker, useSite } from "@/components/site"
import { useTheme } from "@/components/theme"
import { machineIndicators, siteIndicators, sidebarShortcut, type Indicator } from "@/lib/sidebar"
import { ariaCurrent, machinePagesFor, pageUrl, sectionsFor, type MachinePage, type Page, type Section } from "@/lib/pages"
import { TONE_PILL, TONE_DOT, type Tone } from "@/lib/tones"
import { cn } from "@/lib/utils"

/** The icon of each machine page. */
export const MACHINE_ICONS: Record<MachinePage, LucideIcon> = {
  home: Globe,
  activity: History,
  team: Users,
  members: Contact,
  connectors: Plug,
}

/** The icon of each section of a site, shared by the sidebar and the tabs. */
export const SECTION_ICONS: Record<Section, LucideIcon> = {
  overview: Gauge,
  audience: ChartNoAxesColumn,
  secrets: KeyRound,
  guests: UsersRound,
  sharing: Share2,
  access: ShieldCheck,
  backups: DatabaseBackup,
}


/** A navigation entry, whatever the level: where it leads, its name, its icon and what it reports. */
type NavEntry = { key: string; target: Page; title: string; Icon: LucideIcon; signal: Indicator | null }

/** The entries of the current level: the machine's pages, or the site's sections. */
function useNavEntries(): NavEntry[] {
  const { page } = useNavigation()
  const { snapshot, guests, now, offset, identity } = useData()
  const slug = page.name === "site" ? page.slug : ""
  const { site, discrepancies, project } = useSite(slug)
  const list = guests.list

  return useMemo(() => {
    if (page.name !== "site") {
      const signals = machineIndicators(snapshot?.discrepancies ?? null)
      return machinePagesFor(identity).map((entry) => ({
        key: entry.name,
        target: { name: entry.name },
        title: entry.title,
        Icon: MACHINE_ICONS[entry.name],
        signal: signals[entry.name],
      }))
    }
    const siteGuestsList =
      site === null || list.state !== "ready" ? null : list.guests.filter((guest) => guest.host === site.address)
    const signals = siteIndicators({
      discrepancies: snapshot === null ? null : discrepancies,
      project,
      site,
      guests: siteGuestsList,
      now,
      serverNow: now + offset,
    })
    return sectionsFor(identity).map((entry) => ({
      key: entry.section,
      target: { name: "site", slug: page.slug, section: entry.section },
      title: entry.title,
      Icon: SECTION_ICONS[entry.section],
      signal: signals[entry.section],
    }))
  }, [page, snapshot, site, discrepancies, project, list, now, offset, identity])
}

/** An indicator's word for screen readers, which the figure alone does not say. */
function HiddenIndicator({ indicator }: { indicator: Indicator | null }) {
  if (indicator === null) return null
  return <span className="sr-only">, {indicator.label}</span>
}

/**
 * A navigation entry: 36 px, its icon at 16 px. The current page takes the
 * accent's palest tint, `highlight`, and on its left edge a two pixel bar of
 * the accent itself: petrol is the one colour the page gives to "you are
 * here", and a hover keeps the grey, so the two never look alike.
 */
const SIDEBAR_BUTTON =
  "h-9 gap-2.5 rounded-lg px-2.5 text-secondary-foreground hover:bg-sidebar-accent hover:text-strong data-active:bg-highlight data-active:font-medium data-active:text-strong data-active:shadow-[inset_2px_0_0_var(--sidebar-primary)]"

/** The sidebar's own controls, below the pages: quieter than them. */
const SIDEBAR_CONTROL = "h-9 gap-2.5 rounded-lg px-2.5 text-muted-foreground hover:bg-sidebar-accent hover:text-strong"

function SidebarEntries({ entries, label }: { entries: NavEntry[]; label: string }) {
  const { page } = useNavigation()
  const { state } = useSidebar()
  const collapsed = state === "collapsed"
  return (
    <nav aria-label={label}>
      <SidebarMenu className="gap-0.5">
        {entries.map(({ key, target, title, Icon, signal }) => {
          const current = ariaCurrent(page, target)
          return (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton
                isActive={current !== undefined}
                tooltip={signal === null ? title : `${title}: ${signal.label}`}
                render={<InternalLink href={pageUrl(target)} aria-current={current} />}
                className={SIDEBAR_BUTTON}
              >
                <span className="relative">
                  <Icon />
                  {collapsed && signal !== null && signal.tone !== "neutral" && (
                    <span
                      aria-hidden="true"
                      className={cn("absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-sidebar", TONE_DOT[signal.tone])}
                    />
                  )}
                </span>
                <span>
                  {title}
                  <HiddenIndicator indicator={signal} />
                </span>
              </SidebarMenuButton>
              {signal !== null && (
                <SidebarMenuBadge
                  aria-hidden="true"
                  className={cn(
                    "top-2 right-2 rounded-sm px-1.5",
                    signal.tone === "neutral" ? "text-muted-foreground" : cn("font-semibold", TONE_PILL[signal.tone]),
                  )}
                >
                  {signal.count}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </nav>
  )
}

/**
 * The sidebar, on a computer, has two levels. On the home page and on Activity,
 * the machine's pages. Inside a site, the return to all sites, the current site
 * and its switcher, then its sections. Collapsed, it keeps only the icons,
 * their tooltip, and a dot on those reporting something worth a look; `Cmd+B`
 * or `Ctrl+B` collapses and expands it.
 */
export function AppSidebar() {
  const { page } = useNavigation()
  const { signOut, snapshot, identity } = useData()
  const { toggleSidebar } = useSidebar()
  const theme = useTheme()
  const entries = useNavEntries()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-[4.25rem] justify-center px-2 py-0">
        <InternalLink
          href="/"
          aria-label="sitesolide, all sites"
          className="flex h-11 items-center gap-2.5 rounded-lg px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Logo className="size-6 shrink-0" />
          <span className="grid min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-[-0.01em]">sitesolide</span>
            {/* The zone this server serves, once the first snapshot has said it. */}
            {snapshot !== null && snapshot.zone !== "" && (
              <span className="truncate text-xs text-muted-foreground">{snapshot.zone}</span>
            )}
          </span>
        </InternalLink>
      </SidebarHeader>

      <SidebarContent>
        {page.name === "site" ? (
          <>
            <SidebarGroup className="gap-2 pt-1 pb-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="All sites"
                    render={<InternalLink href="/" />}
                    className="h-8 gap-2 rounded-lg px-2.5 text-[0.8125rem] text-muted-foreground hover:bg-sidebar-accent hover:text-strong"
                  >
                    <ChevronLeft />
                    <span>All sites</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem className="mt-1">
                  <SidebarSitePicker slug={page.slug} section={page.section} />
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarEntries entries={entries} label={`${page.slug} sections`} />
            </SidebarGroup>
          </>
        ) : (
          <SidebarGroup className="pt-1">
            <SidebarEntries entries={entries} label="Pages" />
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="pb-3">
        {identity !== null && identity.kind === "member" && (
          <p className="truncate px-2.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" title={identity.email}>
            {identity.email}
          </p>
        )}
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={theme.label}
              onClick={theme.toggle}
              className={SIDEBAR_CONTROL}
            >
              <theme.Icon />
              <span>{theme.theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" onClick={signOut} className={SIDEBAR_CONTROL}>
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Expand sidebar"
              onClick={toggleSidebar}
              aria-keyshortcuts="Meta+B Control+B"
              className={SIDEBAR_CONTROL}
            >
              <PanelLeft />
              <span className="flex flex-1 items-center justify-between">
                Collapse sidebar
                <kbd className="font-sans text-xs text-muted-foreground">{sidebarShortcut(navigator.userAgent)}</kbd>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

/**
 * A count on a tone's solid dot, beside the tab's icon. Near black on green and
 * amber, in both themes; on the error red, the card's colour, white in light
 * and near black in dark. The contrasts are in styles/global.css.
 */
const TAB_BADGE_TEXT: Record<Exclude<Tone, "neutral">, string> = {
  ok: "text-foreground dark:text-background",
  attention: "text-foreground dark:text-background",
  error: "text-card",
}

/**
 * One row of tabs whatever their number, spelled out for Tailwind, which only
 * generates the classes it finds written whole. A count missing here wrapped
 * the tabs onto rows of two, three rows tall once a site had six sections.
 */
const TAB_COLUMNS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
}

/**
 * On a phone, the entries of the current level at the bottom of the screen,
 * within thumb's reach: the machine's pages, or the site's sections.
 * Targets 64 px tall, above the system's gesture area.
 */
export function MobileTabs() {
  const { page } = useNavigation()
  const entries = useNavEntries()
  return (
    <nav
      aria-label={page.name === "site" ? `${page.slug} sections` : "Pages"}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <ul className={cn("grid", TAB_COLUMNS[entries.length] ?? "grid-cols-2")}>
        {entries.map(({ key, target, title, Icon, signal }) => {
          const current = ariaCurrent(page, target)
          return (
            <li key={key}>
              <InternalLink
                href={pageUrl(target)}
                aria-current={current}
                className={cn(
                  "relative flex h-16 flex-col items-center justify-center gap-1 text-xs outline-none focus-visible:bg-muted",
                  current !== undefined ? "font-medium text-strong" : "text-muted-foreground",
                )}
              >
                {current !== undefined && (
                  <span aria-hidden="true" className="absolute inset-x-5 top-0 h-0.5 rounded-b-sm bg-primary" />
                )}
                <span className="relative">
                  <Icon aria-hidden="true" className="size-5" strokeWidth={current !== undefined ? 2.25 : 1.75} />
                  {signal !== null && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute -top-1.5 left-3 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] leading-none font-semibold ring-2 ring-background tabular-nums",
                        signal.tone === "neutral" ? "bg-muted text-muted-foreground" : cn(TAB_BADGE_TEXT[signal.tone], TONE_DOT[signal.tone]),
                      )}
                    >
                      {signal.count}
                    </span>
                  )}
                </span>
                {title}
                <HiddenIndicator indicator={signal} />
              </InternalLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
