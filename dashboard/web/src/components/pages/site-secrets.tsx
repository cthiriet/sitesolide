import { CloudOff, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { Banner, ErrorState, EmptyState, Panel, PanelSkeleton, useRetry } from "@/components/page"
import { FilesPanel } from "@/components/secrets"
import { SecretsLog } from "@/components/secrets-log"
import { Code, StoreSection } from "@/components/secrets-store"
import { SitePage, useSite } from "@/components/site"
import { UNREACHABLE } from "@/lib/secrets"
import { isPerson, roleOn } from "@/lib/identity"

/*
 * Nothing here knows any site in particular. The platform deploys sites whose
 * business it does not know: a site that reads its secrets another way, from a
 * database of its own for instance, says so in its own README, not in this
 * dashboard.
 */

/**
 * The header's intro: when a change applies, and, for a Developer or an
 * Admin, that no value comes back to them. The unlock is asked for when a
 * write is pressed.
 */
function Intro({ slug }: { slug: string }) {
  const { identity } = useData()
  const role = roleOn(identity, slug)
  const hidden = role === "developer" || role === "admin" ? " Only the owner of the server reads a value back." : ""
  return (
    <p>
      {slug} reads these when it starts: a change applies after a restart.{hidden}
    </p>
  )
}

function Content({ slug }: { slug: string }) {
  const { secrets, identity } = useData()
  const person = isPerson(identity)
  const { project, site } = useSite(slug)
  const store = project?.store ?? null
  const shown = store !== null || (project !== null && project.files.length > 0)
  const { projects, problem, reload } = secrets
  const { retrying, retry } = useRetry(reload)

  return (
    <>
      {problem !== null && projects !== null && (
        <Banner
          tone="attention"
          icon={CloudOff}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={retry}
              disabled={retrying}
              className="max-md:h-9"
            >
              {retrying ? "Retrying…" : "Retry"}
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
            onRetry={retry}
            inProgress={retrying}
          >
            {problem === UNREACHABLE ? (
              person ? (
                "The rest of the dashboard works, but no secret can be read or changed until it answers. If it lasts, tell the owner of the server."
              ) : (
                <>
                  The rest of the dashboard works, but no secret can be read or changed until it answers. Check{" "}
                  <code className="font-mono text-xs">systemctl status sitesolide-steward</code> on the server.
                </>
              )
            ) : (
              problem
            )}
          </ErrorState>
        </Panel>
      )}

      {projects !== null && (project === null || !shown) && (
        <Panel>
          <EmptyState icon={FileText} title={`${slug} has no secrets`}>
            {project === null ? (
              <>The server doesn't list {slug}. A site is listed once it is deployed.</>
            ) : site?.type === "static" ? (
              <>
                A static site has no service to read a secret when it runs. A value its build needs is named under{" "}
                <Code>secrets.build</Code> in its <Code>sitesolide.json</Code>, and stays with whoever deploys.
              </>
            ) : (
              <>
                To give it some, declare them under <Code>secrets</Code> in its <Code>sitesolide.json</Code>, then run{" "}
                <Code>sitesolide deploy</Code> from its folder.
              </>
            )}
          </EmptyState>
        </Panel>
      )}

      {project !== null && store !== null && (
        // The key unmounts the rows and dialogs on every project: no value revealed or typed carries over.
        <StoreSection key={project.slug} project={project} store={store} />
      )}

      {project !== null && store === null && project.files.length > 0 && (
        // No store: the dashboard and the portal, whose own files are listed instead.
        <FilesPanel key={project.slug} project={project} />
      )}

      {projects !== null && <SecretsLog slug={slug} />}
    </>
  )
}

/**
 * A site's secrets, under `/site/secrets/?s=<slug>`: its service and what is
 * wrong, then its store (variables, what is missing, files, the build's
 * names, the public values) or, for the dashboard and the portal, each of
 * their own files and its actions; then its activity. No value at all, but
 * the one the owner reveals.
 */
export function SecretsSection({ slug }: { slug: string }) {
  const { project } = useSite(slug)
  // A site with nothing to read has no intro about reading: its empty state says why.
  const reads = project === null || project.store !== null || project.files.length > 0
  return (
    <SitePage
      slug={slug}
      section="secrets"
      intro={reads ? <Intro slug={slug} /> : undefined}
      history={{ target: slug, type: "secrets" }}
      skeleton={<PanelSkeleton lines={5} />}
    >
      {() => <Content slug={slug} />}
    </SitePage>
  )
}
