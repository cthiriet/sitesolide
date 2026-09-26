import { useRef } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { LoadAdvice, ExpiredSubheading, GuestRow, useGuestActions } from "@/components/guests"
import { Banner, ErrorState, EmptyState, Panel, RowsSkeleton } from "@/components/page"
import { SectionLink } from "@/components/site"
import { siteGuests, canHaveGuests } from "@/lib/invitations"
import type { Guest } from "@/lib/guests"

const NONE: { active: Guest[]; expired: Guest[] } = { active: [], expired: [] }

/**
 * A site's guests, on its Overview: the active ones first, a near expiry
 * flagged, the expired ones apart; *Create access* with this site already
 * chosen, the revocation, and the way to its Guests section.
 *
 * Renders nothing for a site that is not behind the applied portal: an access
 * would close nothing there, and the service would refuse it. The rule is
 * `canHaveGuests`, read from the snapshot.
 */
export function SiteGuestsPanel({ slug }: { slug: string }) {
  const { snapshot, guests, now } = useData()
  const sites = snapshot?.sites ?? []
  const site = sites.find((candidate) => candidate.slug === slug)
  const list = guests.list
  const { active, expired } =
    site !== undefined && list.state === "ready" ? siteGuests(list.guests, site.address, now) : NONE
  const button = useRef<HTMLButtonElement>(null)
  const actions = useGuestActions({ sites, order: [...active, ...expired], fallback: () => button.current })

  if (site === undefined || !canHaveGuests(site)) return null

  return (
    <Panel
      title="Guests"
      count={active.length > 0 ? active.length : undefined}
      full
      actions={
        <>
          <SectionLink slug={slug} section="guests" />
          {list.state === "ready" && (
            <Button ref={button} variant="outline" size="sm" onClick={() => actions.create(site.address)} className="max-md:h-9">
              <Plus />
              Create access
            </Button>
          )}
        </>
      }
    >
      {list.state === "loading" && (
        <div aria-busy="true" aria-label="Loading guest access">
          <RowsSkeleton lines={2} />
        </div>
      )}

      {list.state === "error" && (
        <ErrorState title={list.message} onRetry={() => void guests.reload({ showLoading: true })} compact>
          <LoadAdvice reason={list.message} />
        </ErrorState>
      )}

      {list.state === "ready" && active.length + expired.length === 0 && (
        <EmptyState title={`No guest access to ${slug}`} compact>
          A guest gets their own password for this site, and the same rights as you here.
        </EmptyState>
      )}

      {actions.error !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{actions.error}</Banner>
        </div>
      )}

      {list.state === "ready" && active.length + expired.length > 0 && (
        <ul className="divide-y" aria-label={`Guest access to ${slug}`}>
          {active.map((guest) => (
            <GuestRow key={guest.id} guest={guest} slug={slug} now={now} actions={actions} />
          ))}
          {expired.length > 0 && <ExpiredSubheading count={expired.length} />}
          {expired.map((guest) => (
            <GuestRow key={guest.id} guest={guest} slug={slug} now={now} actions={actions} />
          ))}
        </ul>
      )}

      {actions.dialogs}
    </Panel>
  )
}
