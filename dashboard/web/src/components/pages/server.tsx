import { CloudOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, ErrorState, PageBody, PageHeader, Panel, PanelSkeleton, useRetry } from "@/components/page"
import { ServerSetupProvider, SettingRow, useServerSetup } from "@/components/server-setup"
import { siteUrl } from "@/lib/pages"
import { UNREACHABLE } from "@/lib/secrets"
import { SERVER_GROUPS, serverRow, sitesRowIds } from "@/lib/server-setup"

/**
 * The server's own settings, the owner's alone: how it tells you it is
 * down, who signs in, where its backups go. Every setting, done or not,
 * always in the same order, in three panels each saying when a change
 * applies; the same rows as the setup guide on Sites, which lists only
 * what is missing. The files they live in stay one link away, in the
 * Secrets of the dashboard site, for repairs.
 */
function Content() {
  const setup = useServerSetup()
  const { secrets } = useData()
  const { projects, problem, reload } = secrets
  const { retrying, retry } = useRetry(reload)

  if (projects === null && problem === null) {
    return (
      <div aria-busy="true" aria-label="Loading the server's settings" className="grid gap-6">
        <PanelSkeleton lines={2} />
        <PanelSkeleton lines={3} />
        <PanelSkeleton lines={1} />
      </div>
    )
  }
  if (projects === null) {
    return (
      <Panel>
        <ErrorState title={problem === UNREACHABLE ? UNREACHABLE : "Couldn't load the server's settings."} onRetry={retry} inProgress={retrying}>
          {problem === UNREACHABLE ? (
            <>
              The rest of the dashboard works, but no setting can be read or changed until it answers. Check{" "}
              <code className="font-mono text-xs">systemctl status sitesolide-steward</code> on the server.
            </>
          ) : (
            problem
          )}
        </ErrorState>
      </Panel>
    )
  }

  // The guide hidden on Sites while something is still missing: one quiet line says how to have it back.
  const hiddenWithWork = setup.hidden && sitesRowIds({ ...setup.inputs, hidden: false, guideOpen: null }).length > 0

  return (
    <>
      {problem !== null && (
        <Banner
          tone="attention"
          icon={CloudOff}
          action={
            <Button variant="outline" size="sm" onClick={retry} disabled={retrying} className="max-md:h-9">
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          }
        >
          {problem === UNREACHABLE ? `${UNREACHABLE} Showing the last state received.` : problem}
        </Banner>
      )}
      {hiddenWithWork && (
        <p className="-mb-2 px-1 text-[0.8125rem] text-muted-foreground">
          The setup guide is hidden on Sites.{" "}
          <Button variant="link" onClick={setup.showGuide} className="h-auto p-0 text-[0.8125rem]">
            Show it again
          </Button>
        </p>
      )}
      {SERVER_GROUPS.map((group) => (
        <Panel key={group.id} full title={group.title} actions={<span className="text-xs text-muted-foreground">{group.note}</span>}>
          <div role="list" aria-label={group.title} className="@container/settings">
            {group.rows.map((id) => (
              <SettingRow key={id} view={serverRow(id, setup.inputs)} place="server" />
            ))}
          </div>
        </Panel>
      ))}
      <p className="px-1 text-[0.8125rem] text-muted-foreground">
        Advanced: the server's files, in the{" "}
        <InternalLink href={siteUrl("dashboard", "secrets")} className="rounded-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Secrets of the dashboard site
        </InternalLink>
        .
      </p>
    </>
  )
}

export function ServerPage() {
  return (
    <ServerSetupProvider place="server">
      <PageHeader
        title="Server"
        intro={
          <>
            <p>The server's own settings: how it tells you it is down, who signs in, where its backups go. Only you see this page.</p>
            <p className="text-muted-foreground">They belong to the server, not to a site: no site reads them.</p>
            <p className="text-muted-foreground">
              Every setting stays here for good. When the setup guide is shown on Sites, it walks through the ones still missing.
            </p>
          </>
        }
        history={{ type: "secrets" }}
      />
      <PageBody>
        <Content />
      </PageBody>
    </ServerSetupProvider>
  )
}
