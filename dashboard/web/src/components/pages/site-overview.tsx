import { useData } from "@/components/data"
import { SiteGuestsPanel } from "@/components/guests-site"
import { ExternalLink } from "@/components/link"
import { PanelSkeleton } from "@/components/page"
import { SiteSecretsPanel } from "@/components/secrets-site"
import { SiteState, SectionLink, SitePage, useSite } from "@/components/site"
import { SiteDiscrepancies, AccessPanel, AddressesPanel, ServicePanel, StoragePanel } from "@/components/site-card"
import { siteAddress } from "@/lib/sites"
import type { Discrepancy, Site } from "@/lib/types"

/** Under the title: the site's state in one sentence, its description and its main address. */
function Summary({ site, discrepancies }: { site: Site; discrepancies: readonly Discrepancy[] }) {
  const address = siteAddress(site)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <SiteState site={site} discrepancies={discrepancies} />
      {site.description !== null && <span lang="fr">{site.description}</span>}
      <ExternalLink href={address.href} className="text-foreground">
        {address.text}
      </ExternalLink>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid items-start gap-6 @4xl/body:grid-cols-2">
      <div className="grid gap-6">
        <PanelSkeleton lines={5} />
        <PanelSkeleton lines={2} />
      </div>
      <div className="grid gap-6">
        <PanelSkeleton lines={3} />
        <PanelSkeleton lines={2} />
      </div>
    </div>
  )
}

/**
 * A site's Overview, under `/site/?s=<slug>`: its discrepancies first, then two
 * columns. On the left the site on the machine, what is running, where it
 * answers and what it weighs; on the right what opens it and what it keeps, its
 * door, its guests and its secrets, each with the way to its section. A single
 * column below that width, in document order. Guests and secrets render nothing
 * for a site that has none.
 */
export function OverviewSection({ slug }: { slug: string }) {
  const { now } = useData()
  const { site, discrepancies } = useSite(slug)
  return (
    <SitePage
      slug={slug}
      section="overview"
      description={site === null ? undefined : <Summary site={site} discrepancies={discrepancies} />}
      skeleton={<OverviewSkeleton />}
    >
      {(snapshot) => (
        <>
          <SiteDiscrepancies discrepancies={discrepancies} />
          <div className="grid items-start gap-6 @4xl/body:grid-cols-2">
            <div className="grid min-w-0 gap-6">
              <ServicePanel site={snapshot} now={now} />
              <AddressesPanel site={snapshot} />
              <StoragePanel site={snapshot} now={now} />
            </div>
            <div className="grid min-w-0 gap-6">
              <AccessPanel site={snapshot} actions={<SectionLink slug={slug} section="access" />} />
              <SiteGuestsPanel slug={slug} />
              <SiteSecretsPanel slug={slug} />
            </div>
          </div>
        </>
      )}
    </SitePage>
  )
}
