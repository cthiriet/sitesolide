import { useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { CreateGuestDialog, RevokeGuestDialog } from "@/components/guest-dialogs"
import { Count, Status } from "@/components/page"
import { revokeGuest } from "@/lib/api"
import { dateTime, ago } from "@/lib/format"
import {
  guestActivity,
  focusCandidates,
  loadAdvice,
  endDate,
  lastVisit,
  deadline,
  guestRefusal,
  sitesWithGuests,
} from "@/lib/invitations"
import type { Guest } from "@/lib/guests"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Guest access to the sites behind the portal: one password per person and per
 * site, shown only once, revocable at any time. A revocation takes effect from
 * the guest's next request, the portal reading the access again on every
 * request.
 *
 * This file holds what a site's Guests section and its Overview share: the
 * actions and their dialogs, and the pieces of a row.
 */

// --- The actions -----------------------------------------------------------------

export type GuestActions = {
  /** The sites where an access can be created, by slug. */
  guestSites: Site[]
  /** Opens the creation, with this site already chosen if one is given. */
  create: (host?: string) => void
  /** Asks for confirmation of a revocation. */
  revoke: (guest: Guest) => void
  /** Removes an expired access, with no confirmation: it opens nothing any more. */
  remove: (guest: Guest) => Promise<void>
  /** The access being removed, to disable its button. */
  removal: string | null
  /** The refusal of a removal, to be shown above the list. */
  error: string
  /** The two dialogs, to be rendered once per list. */
  dialogs: ReactNode
}

/**
 * The writes on accesses: create, revoke, remove an expired one. Each of them
 * reads the list again afterwards, and a 401 hands over to the sign-in.
 *
 * `order` is the list as it is displayed: when a row disappears, focus goes to
 * the next one's button, otherwise the previous one's, otherwise to `fallback`.
 */
export function useGuestActions({
  sites,
  order,
  fallback,
}: {
  sites: readonly Site[]
  order: readonly Guest[]
  fallback: () => HTMLElement | null
}): GuestActions {
  const { guests, sessionExpired } = useData()
  const announce = useAnnounce()
  const guestSites = sitesWithGuests(sites)

  // The key remounts the dialog on every opening: nothing from a previous creation survives.
  const [creation, setCreation] = useState<{ key: number; open: boolean; host: string | null }>({
    key: 0,
    open: false,
    host: null,
  })
  const [revocation, setRevocation] = useState<{ guest: Guest; open: boolean } | null>(null)
  const [enRevocation, setEnRevocation] = useState(false)
  const [revokeError, setRevokeError] = useState("")
  const [removal, setRemoval] = useState<string | null>(null)
  const [error, setError] = useState("")
  const focusTarget = useRef<HTMLElement | null>(null)
  const createOrigin = useRef<HTMLElement | null>(null)

  /** The visible button only: the table and the phone list coexist in the document. */
  function neighbour(id: string): HTMLElement | null {
    for (const candidate of focusCandidates(
      order.map((guest) => guest.id),
      id,
    )) {
      const buttons = document.querySelectorAll<HTMLElement>(`[data-action-guest="${CSS.escape(candidate)}"]`)
      const visible = [...buttons].find((button) => button.getClientRects().length > 0)
      if (visible !== undefined) return visible
    }
    return fallback()
  }

  function create(host?: string) {
    createOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError("")
    setCreation((before) => ({ key: before.key + 1, open: true, host: host ?? null }))
  }

  function revoke(guest: Guest) {
    focusTarget.current = null
    setRevokeError("")
    setRevocation({ guest, open: true })
  }

  async function confirmRevoke() {
    const guest = revocation?.guest
    if (guest === undefined || enRevocation) return
    setEnRevocation(true)
    setRevokeError("")
    try {
      const { status, body } = await revokeGuest(guest.id)
      if (status === 401) {
        setRevocation({ guest, open: false })
        return sessionExpired()
      }
      // 404: already removed elsewhere, which comes to the same thing.
      if (status !== 204 && status !== 404) return setRevokeError(guestRefusal(status, body).message)
      focusTarget.current = neighbour(guest.id)
      setRevocation({ guest, open: false })
      announce(`Access revoked for ${guest.label}`)
      await guests.reload()
    } finally {
      setEnRevocation(false)
    }
  }

  async function remove(guest: Guest) {
    if (removal !== null) return
    setError("")
    setRemoval(guest.id)
    try {
      const target = neighbour(guest.id)
      const { status, body } = await revokeGuest(guest.id)
      if (status === 401) return sessionExpired()
      if (status !== 204 && status !== 404) return setError(guestRefusal(status, body).message)
      announce(`Expired access removed for ${guest.label}`)
      await guests.reload()
      target?.focus()
    } finally {
      setRemoval(null)
    }
  }

  const dialogs = (
    <>
      {creation.key > 0 && (
        <CreateGuestDialog
          key={creation.key}
          open={creation.open}
          requestedHost={creation.host}
          sites={guestSites}
          onClose={() => setCreation((before) => ({ ...before, open: false }))}
          focusReturn={() => {
            // The originating button may have disappeared, or never had focus: Safari
            // does not give it to a clicked button. The visible create button replaces it.
            const origin = createOrigin.current
            const valid = origin !== null && origin !== document.body && origin.isConnected
            return valid ? origin : (fallback() ?? true)
          }}
        />
      )}
      <RevokeGuestDialog
        guest={revocation?.guest ?? null}
        open={revocation?.open ?? false}
        inProgress={enRevocation}
        error={revokeError}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => revocation !== null && setRevocation({ ...revocation, open: false })}
        focusReturn={() => focusTarget.current ?? true}
      />
    </>
  )

  return { guestSites, create, revoke, remove, removal, error, dialogs }
}

// --- The pieces of a row ---------------------------------------------------------

/** What to do when the list could not be read, depending on what did not answer. */
export function LoadAdvice({ reason }: { reason: string }) {
  const { text, command } = loadAdvice(reason)
  if (command === null) return <>{text}</>
  return (
    <>
      {text} <code className="font-mono text-xs whitespace-nowrap">{command}</code> on the server.
    </>
  )
}

/**
 * *Revoke* for an active access, *Remove* for an expired one. Focus finds it
 * again through `data-action-guest` when a neighbouring row disappears.
 */
export function GuestActionButton({
  guest,
  slug,
  now,
  actions,
  className,
}: {
  guest: Guest
  slug: string
  now: number
  actions: GuestActions
  className?: string
}) {
  const isExpired = deadline(guest, now).tone === "expired"
  const removing = actions.removal === guest.id
  return (
    <Button
      variant="ghost"
      size="sm"
      data-action-guest={guest.id}
      aria-label={
        isExpired ? `Remove expired access for ${guest.label} on ${slug}` : `Revoke access for ${guest.label} on ${slug}`
      }
      disabled={removing}
      onClick={() => (isExpired ? void actions.remove(guest) : actions.revoke(guest))}
      className={cn(
        "text-muted-foreground hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15",
        className,
      )}
    >
      {isExpired ? (removing ? "Removing…" : "Remove") : "Revoke"}
    </Button>
  )
}

/**
 * The relative expiry, with the attention tone under twenty-four hours. A dot
 * and a word, never the colour alone: the title and the hidden text say why it
 * stands out.
 */
export function GuestExpiry({
  guest,
  now,
  prefix = false,
}: {
  guest: Guest
  now: number
  /** "Expires in 5h" rather than "in 5h", where no column says it. */
  prefix?: boolean
}) {
  const finish = deadline(guest, now)
  const text = prefix && (finish.tone === "normal" || finish.tone === "soon") ? `Expires ${finish.text}` : finish.text
  if (finish.tone === "soon") {
    return (
      <Status tone="attention" title="Ends within 24 hours" className="font-medium">
        {text}
        <span className="sr-only">, ends within 24 hours</span>
      </Status>
    )
  }
  return <span className={cn(finish.tone !== "normal" && "text-muted-foreground")}>{text}</span>
}

/**
 * An access on a list row, where there are no columns: phone, a site's
 * Overview. The name, then the expiry, then the activity.
 */
export function GuestRow({
  guest,
  slug,
  now,
  actions,
}: {
  guest: Guest
  slug: string
  now: number
  actions: GuestActions
}) {
  const isExpired = deadline(guest, now).tone === "expired"
  const finish = endDate(guest)
  return (
    <li className="flex items-start gap-3 py-3 pr-2 pl-4">
      <div className={cn("grid min-w-0 flex-1 gap-0.5", isExpired && "text-muted-foreground")}>
        <span className="font-medium wrap-anywhere">{guest.label}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
          <span className="tabular-nums">
            <GuestExpiry guest={guest} now={now} prefix />
            {finish !== null && !isExpired && <span className="text-muted-foreground"> ({finish})</span>}
          </span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{guestActivity(guest, now)}</span>
      </div>
      <GuestActionButton guest={guest} slug={slug} now={now} actions={actions} className="-my-1 h-11 px-3 text-sm md:h-8" />
    </li>
  )
}

/** The subheading for expired ones in a list: apart, and discreet. */
export function ExpiredSubheading({ count }: { count: number }) {
  return (
    <li className="flex h-9 items-center gap-2 bg-muted/50 px-4 text-xs font-medium text-muted-foreground">
      Expired
      <Count className="bg-background/70">{count}</Count>
    </li>
  )
}

// --- The table -------------------------------------------------------------------

const HEAD = "h-9 px-3 text-xs font-medium text-muted-foreground"
const CELL = "px-3 py-2.5"

function GuestTableRow({
  guest,
  slug,
  now,
  actions,
}: {
  guest: Guest
  slug: string
  now: number
  actions: GuestActions
}) {
  const isExpired = deadline(guest, now).tone === "expired"
  const finish = endDate(guest)
  return (
    <TableRow className={cn("hover:bg-transparent", isExpired && "text-muted-foreground")}>
      <TableCell className={cn(CELL, "max-w-72 min-w-44 pl-4 font-medium whitespace-normal wrap-anywhere")}>
        {guest.label}
      </TableCell>
      <TableCell className={cn(CELL, "tabular-nums")}>
        {/* The date follows the relative expiry when the panel allows it, aligned from row to row; below that, on hover. */}
        <span title={finish ?? undefined} className="@4xl:inline-block @4xl:min-w-20">
          <GuestExpiry guest={guest} now={now} />
        </span>
        {finish !== null && !isExpired && <span className="ml-2 hidden text-muted-foreground @4xl:inline">{finish}</span>}
      </TableCell>
      <TableCell className={cn(CELL, "text-muted-foreground tabular-nums")}>{lastVisit(guest, now)}</TableCell>
      <TableCell className={cn(CELL, "text-muted-foreground tabular-nums")} title={dateTime(guest.createdAt)}>
        {ago(now - guest.createdAt)}
      </TableCell>
      <TableCell className="py-1.5 pr-3 pl-3 text-right">
        <GuestActionButton guest={guest} slug={slug} now={now} actions={actions} />
      </TableCell>
    </TableRow>
  )
}

/**
 * A site's accesses: a table when the panel has room for its five columns, a
 * divided list otherwise. The active ones first, then the expired ones under
 * their subheading.
 */
export function GuestList({
  active,
  expired,
  slug,
  now,
  actions,
}: {
  active: readonly Guest[]
  expired: readonly Guest[]
  slug: string
  now: number
  actions: GuestActions
}) {
  const line = (guest: Guest) => <GuestTableRow key={guest.id} guest={guest} slug={slug} now={now} actions={actions} />
  return (
    <div className="@container">
      <div className="hidden @2xl:block">
        <Table>
          <caption className="sr-only">Guest access to {slug}. Active access first, soonest expiry first, then expired access.</caption>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "pl-4")}>Guest</TableHead>
              <TableHead className={HEAD}>Expires</TableHead>
              <TableHead className={HEAD}>Last visit</TableHead>
              <TableHead className={HEAD}>Created</TableHead>
              <TableHead className={cn(HEAD, "pr-4")}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          {active.length > 0 && <TableBody>{active.map(line)}</TableBody>}
          {expired.length > 0 && (
            <TableBody className={cn(active.length > 0 && "border-t")}>
              <TableRow className="hover:bg-transparent">
                <TableHead colSpan={5} scope="colgroup" className={cn(HEAD, "bg-muted/50 pl-4")}>
                  <span className="inline-flex items-center gap-2">
                    Expired
                    <Count className="bg-background/70">{expired.length}</Count>
                  </span>
                </TableHead>
              </TableRow>
              {expired.map(line)}
            </TableBody>
          )}
        </Table>
      </div>

      <ul className="divide-y @2xl:hidden" aria-label={`Guest access to ${slug}`}>
        {active.map((guest) => (
          <GuestRow key={guest.id} guest={guest} slug={slug} now={now} actions={actions} />
        ))}
        {expired.length > 0 && <ExpiredSubheading count={expired.length} />}
        {expired.map((guest) => (
          <GuestRow key={guest.id} guest={guest} slug={slug} now={now} actions={actions} />
        ))}
      </ul>
    </div>
  )
}
