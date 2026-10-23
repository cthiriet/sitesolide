import { useState } from "react"
import { CloudOff, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { Banner, ErrorState, EmptyState, Panel, PanelSkeleton } from "@/components/page"
import { FilesPanel, SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { SecretsLog } from "@/components/secrets-log"
import { StoreSection } from "@/components/secrets-store"
import { SitePage, useSite } from "@/components/site"
import { UNREACHABLE } from "@/lib/secrets"
import { isPerson, roleOn } from "@/lib/identity"

/*
 * Nothing here knows any site in particular. The platform deploys sites whose
 * business it does not know: a site that reads its secrets another way, from a
 * database of its own for instance, says so in its own README, not in this
 * dashboard.
 */

function Code({ children }: { children: string }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap">{children}</code>
}

/**
 * What unlocking means, for whoever is signed in. Only the owner reads a value
 * back: a Developer and an Admin set, generate and remove, and see names alone.
 */
function Intro({ slug, store }: { slug: string; store: boolean }) {
  const { identity, sso } = useData()
  const role = roleOn(identity, slug)
  const provider = sso.providerName ?? "your identity provider"
  const reads = store ? "Its services read these values when they start" : `${slug} reads these files when it starts`
  if (role === "developer" || role === "admin") {
    return (
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        As {role === "admin" ? "an Admin" : "a Developer"} on {slug}, you set, generate and remove its values, and never
        read one back: only the owner of the server does. {reads}. To change one, unlock by signing in again with{" "}
        {provider}; a change reaches {slug} only after a restart.
      </p>
    )
  }
  return (
    <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
      {reads}. Values stay hidden: unlock with the dashboard password to change one, or to reveal one for thirty
      seconds, which nobody but you can do. A change reaches {slug} only after a restart.
    </p>
  )
}

function Content({ slug }: { slug: string }) {
  const { secrets, identity } = useData()
  const person = isPerson(identity)
  const actions = useSecretsActions()
  const { project, site } = useSite(slug)
  const store = project?.store ?? null
  const shown = store !== null || (project !== null && project.files.length > 0)
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
      {(project === null || shown) && <Intro slug={slug} store={store !== null} />}

      {actions.unlockNotice !== null && <Banner tone="error">{actions.unlockNotice}</Banner>}
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
              person ? (
                "The rest of the dashboard works, but no file can be read or changed until it answers. If it lasts, tell the owner of the server."
              ) : (
                <>
                  The rest of the dashboard works, but no file can be read or changed until it answers. Check{" "}
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
          <EmptyState icon={FileText} title={`${slug} has no secret files`}>
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
        // No store listed: the dashboard and the portal, whose files stay flat, a static site, or a store the
        // steward could not read, which its journal names.
        <FilesPanel key={project.slug} project={project} />
      )}

      {projects !== null && <SecretsLog slug={slug} />}
    </>
  )
}

/**
 * A site's secrets, under `/site/secrets/?s=<slug>`: the lock in the header,
 * its service and what is wrong, then its store (variables, what is missing,
 * files, the build's names, the public values, the legacy files) or, for a
 * project with none, each file and its actions; then its activity. No value
 * at all, but the one the owner reveals.
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
