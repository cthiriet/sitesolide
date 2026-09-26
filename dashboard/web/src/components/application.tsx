import { TooltipProvider } from "@/components/ui/tooltip"
import { Announcements } from "@/components/copy"
import { Shell, PendingShell } from "@/components/shell"
import { DataProvider } from "@/components/data"
import { Router } from "@/components/navigation"

/**
 * The dashboard's single island, mounted by every Astro page with the path of
 * the served file: a reload or a direct link lands on the right file, then
 * navigation stays inside the island.
 *
 * From the outside in: the shared `aria-live` region, the current address, the
 * tooltips, the session and the data, the shell.
 */
export function Application({ path }: { path: string }) {
  return (
    <Announcements>
      <Router path={path}>
        <TooltipProvider delay={300}>
          <DataProvider wait={<PendingShell path={path} />}>
            <Shell />
          </DataProvider>
        </TooltipProvider>
      </Router>
    </Announcements>
  )
}
