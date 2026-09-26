import { CloudOff } from "lucide-react"
import { useData } from "@/components/data"
import { Banner, PanelSkeleton } from "@/components/page"
import { PortalPanel, LockPanel, DeployReminder } from "@/components/portal"
import { useSecretsActions } from "@/components/secrets-actions"
import { SitePage, useSite } from "@/components/site"
import { portalFromSnapshot, toggleTexts } from "@/lib/access"
import { UNREACHABLE } from "@/lib/secrets"
import type { Site } from "@/lib/types"

function Content({ site }: { site: Site }) {
  const { secrets } = useData()
  const actions = useSecretsActions()
  const { project } = useSite(site.slug)
  const stewardRead = project !== null
  const portal = project?.portal ?? portalFromSnapshot(site)
  const change = actions.portalChanged

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        How visitors get into {site.slug}: through the shared portal, with a preview code, or freely. Changes to the
        portal go through the steward, which asks for the dashboard password.
      </p>

      {change !== null && (
        <Banner tone="attention">
          <span className="font-medium">{toggleTexts(site.slug, change.active).succeeded}.</span> The server has it, but
          not your repository yet.
          <div className="mt-2">
            <DeployReminder slug={site.slug} />
          </div>
        </Banner>
      )}

      {!stewardRead && secrets.problem !== null && (
        <Banner tone="attention" icon={CloudOff}>
          {secrets.problem === UNREACHABLE
            ? `${UNREACHABLE} The portal shows as the last snapshot saw it, and can't be changed until it answers.`
            : secrets.problem}
        </Banner>
      )}

      <div className="grid items-start gap-6 @4xl/body:grid-cols-2">
        {!stewardRead && secrets.projects === null && secrets.problem === null ? (
          <PanelSkeleton lines={4} />
        ) : (
          <PortalPanel
            site={site}
            portal={portal}
            stewardRead={stewardRead}
            onToggle={(action) => actions.togglePortal(site.slug, action.active)}
          />
        )}
        <LockPanel site={site} />
      </div>
    </>
  )
}

/**
 * A site's door, under `/site/access/?s=<slug>`: the portal, which is turned on
 * and off here when the steward accepts it, and the preview lock, which is
 * displayed here and set from the workstation.
 */
export function AccessSection({ slug }: { slug: string }) {
  return (
    <SitePage slug={slug} section="access" skeleton={<PanelSkeleton lines={4} />}>
      {(site) => <Content site={site} />}
    </SitePage>
  )
}
