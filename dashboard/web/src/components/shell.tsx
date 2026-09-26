import { useEffect, useRef, useState } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, MobileTabs } from "@/components/sidebar"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { Logo } from "@/components/logo"
import { useNavigation } from "@/components/navigation"
import { CONTAINER, HeaderSkeleton, PanelSkeleton } from "@/components/page"
import { HomePage } from "@/components/pages/home"
import { ActivityPage } from "@/components/pages/activity"
import { AccessSection } from "@/components/pages/site-access"
import { OverviewSection } from "@/components/pages/site-overview"
import { AudienceSection } from "@/components/pages/site-audience"
import { GuestsSection } from "@/components/pages/site-guests"
import { SecretsSection } from "@/components/pages/site-secrets"
import { SecretsActionsProvider } from "@/components/secrets-actions"
import { readCollapsed, storeCollapsed } from "@/lib/sidebar"
import { PAGE_TITLE_ID, pendingTitle, documentTitle, pageTitle, pageUrl, type Page } from "@/lib/pages"
import { cn } from "@/lib/utils"

function Section({ page }: { page: Extract<Page, { name: "site" }> }) {
  switch (page.section) {
    case "overview":
      return <OverviewSection slug={page.slug} />
    case "audience":
      return <AudienceSection slug={page.slug} />
    case "secrets":
      return <SecretsSection slug={page.slug} />
    case "guests":
      return <GuestsSection slug={page.slug} />
    case "access":
      return <AccessSection slug={page.slug} />
  }
}

/**
 * The current page. The actions on secrets and their dialogs live above it,
 * remounted from one site to the next through the key: no dialog carries over
 * to the next site. The section itself is remounted on every section change,
 * and with it any revealed value.
 */
function CurrentPage({ page }: { page: Page }) {
  if (page.name === "site") {
    return (
      <SecretsActionsProvider key={page.slug}>
        <Section key={page.section} page={page} />
      </SecretsActionsProvider>
    )
  }
  return (
    <SecretsActionsProvider key={page.name}>
      {page.name === "home" ? <HomePage /> : <ActivityPage />}
    </SecretsActionsProvider>
  )
}

/**
 * The shell of an open session: the sidebar on a computer, the tabs at the
 * bottom on a phone, and the current page between the two.
 *
 * It is only mounted after the session has been checked, so never at build
 * time: the sidebar's collapsed state can be read straight from storage, with
 * no hydration mismatch. Before it, `PendingShell` holds the place at the
 * same width, read by the inline script in layouts/main.astro.
 */
export function Shell() {
  const { page, fromHistory } = useNavigation()
  const { reading, verdict } = useData()
  const announce = useAnnounce()
  const [collapsed, setCollapsed] = useState(() => readCollapsed(() => window.localStorage))

  // After a navigation, and not on opening: to the top of the page, except on
  // a back whose position the browser restores; focus on the title, so that a
  // keyboard starts again from the top of the page; and the title announced.
  const key = pageUrl(page)
  const title = pageTitle(page)
  const previous = useRef(key)
  useEffect(() => {
    if (previous.current === key) return
    previous.current = key
    if (!fromHistory) window.scrollTo(0, 0)
    document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true })
    announce(title)
  }, [key, title, fromHistory, announce])

  const tabTitle = documentTitle(page, reading === null ? null : verdict)
  useEffect(() => {
    document.title = tabTitle
  }, [tabTitle])

  function onCollapseChange(open: boolean) {
    setCollapsed(!open)
    // A storage that refuses does not prevent the collapse: it will only hold for this page.
    storeCollapsed(() => window.localStorage, !open)
    if (open) document.documentElement.removeAttribute("data-sidebar-collapsed")
    else document.documentElement.setAttribute("data-sidebar-collapsed", "1")
  }

  return (
    <SidebarProvider open={!collapsed} onOpenChange={onCollapseChange}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <CurrentPage page={page} />
      </SidebarInset>
      <MobileTabs />
    </SidebarProvider>
  )
}

/**
 * What the build renders, and what is shown while the session is being checked:
 * the sidebar column at its remembered width, the header with the page title if
 * it does not depend on the site, a panel as a skeleton. Nothing here depends
 * on the data.
 */
export function PendingShell({ path }: { path: string }) {
  const title = pendingTitle(path)
  return (
    <div aria-busy="true" aria-label="Loading" className="flex min-h-svh">
      <div className="hidden w-(--pending-sidebar-width) shrink-0 border-r bg-sidebar md:block">
        <div className="flex h-[4.25rem] items-center px-3.5">
          <Logo className="size-7" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <HeaderSkeleton title={title} />
        <div className={cn(CONTAINER, "pt-6")}>
          <PanelSkeleton lines={6} />
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-0 h-16 border-t bg-background md:hidden" />
    </div>
  )
}
