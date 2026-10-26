import { useEffect, useRef } from "react"
import { Ellipsis, EyeOff, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { RowMenuLink } from "@/components/data-table"
import { InfoButton, Panel } from "@/components/page"
import { SettingRow, useServerSetup } from "@/components/server-setup"
import { pageUrl } from "@/lib/pages"
import { sitesRows } from "@/lib/server-setup"

/**
 * "Set up this server", under the strip of the home page: the owner's
 * alone, the same rows as the Server page but only what the server still
 * lacks, the optional ones skippable, the passwords as two links at its
 * foot. It goes once everything is set or skipped, or when the viewer hides
 * it; every setting stays on the Server page.
 */
export function SetupPanel() {
  const setup = useServerSetup()
  const rows = setup.ready ? sitesRows({ ...setup.inputs, hidden: setup.hidden, guideOpen: setup.guideOpen }) : []
  const count = rows.length

  // The panel goes by itself once a guide or a first ping finishes the last row: said once. Hiding and skipping have their own toast.
  const before = useRef<{ count: number; skipped: number; hidden: boolean } | null>(null)
  useEffect(() => {
    if (!setup.ready) return
    const previous = before.current
    before.current = { count, skipped: setup.prefs.skipped.length, hidden: setup.hidden }
    if (previous === null || previous.count === 0 || count > 0) return
    if (setup.hidden || previous.hidden || setup.prefs.skipped.length > previous.skipped) return
    setup.toast({ text: "The server is set up. The setup guide is gone." })
  }, [setup.ready, count, setup.hidden, setup.prefs.skipped.length])

  if (count === 0) return null
  return (
    <Panel
      full
      title="Set up this server"
      count={count}
      afterTitle={
        <InfoButton label="Why these are here">
          <p className="font-semibold text-strong">Why these are here</p>
          <p className="text-muted-foreground">
            These settings belong to the server, not to a site: how it tells you it is down, where its backups go and who signs in. Only you
            see this guide. It goes away once everything is set up or skipped, and the menu can hide it. Every setting stays on the Server
            page.
          </p>
        </InfoButton>
      }
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Setup guide options"
                data-setup-menu=""
                className="-mr-2 text-muted-foreground hover:text-foreground max-md:size-10"
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <RowMenuLink href={pageUrl({ name: "server" })}>
              <SlidersHorizontal />
              Open the Server page
            </RowMenuLink>
            <DropdownMenuItem onClick={setup.hideGuide} className="h-9">
              <EyeOff />
              Hide the setup guide
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div role="list" aria-label="What the server still lacks" className="@container/settings">
        {rows.map((view) => (
          <SettingRow key={view.id} view={view} place="sites" />
        ))}
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-1 border-t border-divider bg-cell px-4 py-2 text-[0.8125rem]">
        <span className="mono-label">Passwords</span>
        <Button variant="link" onClick={() => setup.changePassword("dashboard-password")} className="h-auto p-0 text-[0.8125rem] max-md:min-h-8">
          Change the dashboard password
        </Button>
        <Button variant="link" onClick={() => setup.changePassword("portal-password")} className="h-auto p-0 text-[0.8125rem] max-md:min-h-8">
          Change the portal password
        </Button>
      </div>
    </Panel>
  )
}
