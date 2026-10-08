import { useEffect, useState } from "react"
import { useData } from "@/components/data"
import { RestartButton } from "@/components/restart-button"
import { ExternalLink } from "@/components/link"
import { PanelSkeleton } from "@/components/page"
import { SiteSecretsPanel } from "@/components/secrets-site"
import { SiteState, SectionLink, SitePage, useSite } from "@/components/site"
import { SiteDiscrepancies, AccessPanel, AddressesPanel, ServicePanel, ServicesPanel, StoragePanel } from "@/components/site-card"
import { readAccess } from "@/lib/api"
import { accessSummary, isPlatform } from "@/lib/access"
import { isPerson, mayRestart, roleOn } from "@/lib/identity"
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

/**
 * Who has access, in a few words, beside the way to the Access section: read
 * with the snapshot, and nothing said until it answers or for the platform's
 * own projects, which nobody is given a role on.
 */
function useAccessSummary(slug: string, enabled: boolean): string | null {
  const { generation } = useData()
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    void readAccess(slug).then(({ status, body }) => {
      if (current && status === 200 && body !== null && Array.isArray(body.entries)) setSummary(accessSummary(body.entries))
    })
    return () => {
      current = false
    }
  }, [slug, enabled, generation])
  return enabled ? summary : null
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
 * answers and what it weighs; on the right what opens it and what it keeps,
 * its general access and its secrets, each with the way to its section. A
 * single column below that width, in document order. Secrets render nothing
 * for a site that has none.
 */
export function OverviewSection({ slug }: { slug: string }) {
  const { now, identity, snapshot: data } = useData()
  // A person sees what their role on the site opens: its secrets from
  // Developer up, and its service's restart as a Developer or an Admin; the
  // steward decides. Everyone with a role sees who has access.
  const role = roleOn(identity, slug)
  const secrets = !isPerson(identity) || role === "developer" || role === "admin"
  const { site, discrepancies } = useSite(slug)
  const summary = useAccessSummary(slug, !isPlatform(slug, data?.zone ?? null))
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
              <ServicePanel site={snapshot} now={now} action={mayRestart(identity, slug) && snapshot.type === "app" ? <RestartButton slug={slug} /> : undefined} />
              <ServicesPanel site={snapshot} />
              <AddressesPanel site={snapshot} />
              <StoragePanel site={snapshot} now={now} />
            </div>
            <div className="grid min-w-0 gap-6">
              <AccessPanel
                site={snapshot}
                plain={isPerson(identity) && role !== "admin"}
                actions={
                  <>
                    {summary !== null && <span className="text-xs text-muted-foreground">{summary} ·</span>}
                    {/* Who only reads the people with access sees them there; an Admin, or the owner, manages them. */}
                    <SectionLink slug={slug} section="access">
                      {!isPerson(identity) || role === "admin" ? "Manage" : "See"}
                    </SectionLink>
                  </>
                }
              />
              {secrets && <SiteSecretsPanel slug={slug} />}
            </div>
          </div>
        </>
      )}
    </SitePage>
  )
}
