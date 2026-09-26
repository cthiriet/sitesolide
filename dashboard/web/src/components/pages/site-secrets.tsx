import { useState } from "react"
import { CloudOff, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { Banner, ErrorState, EmptyState, Panel, PanelSkeleton } from "@/components/page"
import { FilesPanel, SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { SecretsLog } from "@/components/secrets-log"
import { SitePage, useSite } from "@/components/site"
import { UNREACHABLE } from "@/lib/secrets"

/*
 * Nothing here knows any site in particular. The platform deploys sites whose
 * business it does not know: a site that reads its secrets another way, from a
 * database of its own for instance, says so in its own README, not in this
 * dashboard.
 */

function Code({ children }: { children: string }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap">{children}</code>
}

function Content({ slug }: { slug: string }) {
  const { secrets } = useData()
  const actions = useSecretsActions()
  const { project } = useSite(slug)
  const { projects, problem, reload } = secrets
  const [rereading, setRereading] = useState(false)

  async function retry() {
    setRereading(true)
    try {
      await reload()
    } finally {
      setRereading(false)
    }
  }

  return (
    <>
      {(project === null || project.files.length > 0) && (
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          {slug} reads these files when it starts. Values stay hidden until you unlock with the dashboard password, and
          a change reaches {slug} only after a restart.
        </p>
      )}

      {actions.lockError !== "" && <Banner tone="error">Couldn't lock secrets. {actions.lockError}</Banner>}

      {problem !== null && projects !== null && (
        <Banner
          tone="attention"
          icon={CloudOff}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retry()}
              disabled={rereading}
              className="max-md:h-9"
            >
              {rereading ? "Retrying…" : "Retry"}
            </Button>
          }
        >
          {problem === UNREACHABLE ? `${UNREACHABLE} Showing the last state received.` : problem}
        </Banner>
      )}

      {projects === null && problem === null && (
        <div aria-busy="true" aria-label="Loading secrets">
          <PanelSkeleton lines={4} />
        </div>
      )}

      {projects === null && problem !== null && (
        <Panel>
          <ErrorState
            title={problem === UNREACHABLE ? UNREACHABLE : "Couldn't load secrets."}
            onRetry={() => void retry()}
            inProgress={rereading}
          >
            {problem === UNREACHABLE ? (
              <>
                The rest of the dashboard works, but no file can be read or changed until it answers. Check{" "}
                <code className="font-mono text-xs">systemctl status sitesolide-steward</code> on the server.
              </>
            ) : (
              problem
            )}
          </ErrorState>
        </Panel>
      )}

      {projects !== null && (project === null || project.files.length === 0) && (
        <Panel>
          <EmptyState icon={FileText} title={`${slug} has no secret files`}>
            {project === null ? (
              <>The steward doesn't list {slug}. A site is listed once it is deployed.</>
            ) : (
              <>
                To give it some, declare them under <Code>secrets</Code> in its <Code>sitesolide.json</Code>, then run{" "}
                <Code>sitesolide deploy</Code> from its folder.
              </>
            )}
          </EmptyState>
        </Panel>
      )}

      {project !== null && project.files.length > 0 && (
        // The key unmounts the rows on every project: no revealed value carries over.
        <FilesPanel key={project.slug} project={project} />
      )}

      {projects !== null && <SecretsLog slug={slug} />}
    </>
  )
}

/**
 * A site's secrets, under `/site/secrets/?s=<slug>`: the lock in the header,
 * its service and what is wrong, each file and its actions, then its activity,
 * with no values at all.
 */
export function SecretsSection({ slug }: { slug: string }) {
  const { secrets } = useData()
  // No lock until something has been read: a steward that does not answer would refuse.
  const actions = secrets.projects === null ? undefined : <SecretsLockControl />
  return (
    <SitePage slug={slug} section="secrets" actions={actions} skeleton={<PanelSkeleton lines={5} />}>
      {() => <Content slug={slug} />}
    </SitePage>
  )
}
