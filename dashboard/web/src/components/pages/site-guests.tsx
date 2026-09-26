import { DoorClosed, Plus, UsersRound } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { useData } from "@/components/data"
import { LoadAdvice, GuestList, useGuestActions, type GuestActions } from "@/components/guests"
import { InternalLink } from "@/components/navigation"
import { Banner, ErrorState, EmptyState, Panel, PanelSkeleton } from "@/components/page"
import { SitePage, useSite } from "@/components/site"
import { activeCount, canHaveGuests } from "@/lib/invitations"
import type { Guest } from "@/lib/guests"
import { siteUrl } from "@/lib/pages"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

const NONE: { active: Guest[]; expired: Guest[] } = { active: [], expired: [] }

/** The way to a site's portal, which is turned on from its Access section. */
function AccessLink({ slug }: { slug: string }) {
  return (
    <InternalLink href={siteUrl(slug, "access")} className={cn(buttonVariants({ variant: "outline" }), "max-md:h-10")}>
      Open Access
    </InternalLink>
  )
}

/** The create button you can see: the header renders one for the computer and one for the phone. */
function visibleCreateButton(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>("[data-create-access]")
  return [...buttons].find((button) => button.getClientRects().length > 0) ?? null
}

function Content({
  site,
  actions,
  active,
  expired,
}: {
  site: Site
  actions: GuestActions
  active: readonly Guest[]
  expired: readonly Guest[]
}) {
  const { guests, now } = useData()
  const list = guests.list
  const guestsAllowed = canHaveGuests(site)

  if (list.state === "loading") return <PanelSkeleton lines={3} title={false} />

  if (list.state === "error") {
    return (
      <Panel>
        <ErrorState title={list.message} onRetry={() => void guests.reload({ showLoading: true })}>
          <LoadAdvice reason={list.message} />
        </ErrorState>
      </Panel>
    )
  }

  const empty = active.length + expired.length === 0

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        A guest is one person with their own password for {site.slug}, and the same rights as you there. A revoked
        password stops working at their next request.
      </p>

      {!guestsAllowed && empty && (
        <Panel>
          <EmptyState
            icon={DoorClosed}
            title={`${site.slug} isn't behind the portal`}
            action={<AccessLink slug={site.slug} />}
          >
            Guests sign in through the portal, so {site.slug} needs it first. Turn it on from Access.
          </EmptyState>
        </Panel>
      )}

      {!guestsAllowed && !empty && (
        <Banner tone="attention" icon={DoorClosed} action={<AccessLink slug={site.slug} />}>
          {site.slug} isn't behind the portal anymore, so these accesses open nothing and no new one can be created.
        </Banner>
      )}

      {guestsAllowed && empty && (
        <Panel>
          <EmptyState icon={UsersRound} title={`No guest access to ${site.slug} yet`}>
            Use Create access to give one person a password for {site.slug}, shown to you once.
          </EmptyState>
        </Panel>
      )}

      {actions.error !== "" && <Banner tone="error">{actions.error}</Banner>}

      {!empty && (
        <Panel full>
          <GuestList active={active} expired={expired} slug={site.slug} now={now} actions={actions} />
        </Panel>
      )}
    </>
  )
}

/**
 * A site's guest accesses, under `/site/guests/?s=<slug>`: the list, the active
 * ones by expiry then the expired ones, and the creation of an access for this
 * site. With no portal, the section says so and leads to Access.
 */
export function GuestsSection({ slug }: { slug: string }) {
  const { snapshot, guests } = useData()
  const { site, guests: ofSite } = useSite(slug)
  const { active, expired } = ofSite ?? NONE
  const guestActions = useGuestActions({
    sites: snapshot?.sites ?? [],
    order: [...active, ...expired],
    fallback: visibleCreateButton,
  })

  // No button until the list has been read: an unreachable portal would refuse the creation.
  const actions =
    site !== null && canHaveGuests(site) && guests.list.state === "ready" ? (
      <Button data-create-access onClick={() => guestActions.create(site.address)} className="max-md:h-10 max-md:px-3.5">
        <Plus />
        Create access
      </Button>
    ) : undefined

  return (
    <>
      <SitePage
        slug={slug}
        section="guests"
        count={ofSite !== null && active.length > 0 ? activeCount(active.length) : undefined}
        actions={actions}
        skeleton={<PanelSkeleton lines={4} title={false} />}
      >
        {(read) => <Content site={read} actions={guestActions} active={active} expired={expired} />}
      </SitePage>
      {guestActions.dialogs}
    </>
  )
}
