/**
 * What guest accesses decide inside the page: which sites can take them, the
 * order and groups of the list, what an expiry says, the text copied for the
 * guest, the closing of the password screen, and what refusals mean. Pure.
 */
import { fromNow, dateTime, ago } from "./format"
import { LABEL_MAX, cleanLabel, type Guest } from "./guests"
import type { Site } from "./types"

/** Below this delay, the expiry turns to the attention tone: the access ends before tomorrow. */
export const EXPIRY_SOON_MS = 24 * 3600_000

// --- The sites that can take guests ----------------------------------------------

type PortalSite = Pick<Site, "slug" | "address" | "portal">

/**
 * A guest access only makes sense on a site that asks for the portal AND whose
 * live block carries it: a site that asks for it without carrying it is served
 * in the clear, and a password would close nothing there. This is the rule of
 * `invitableHosts` in src/guests.ts, which the service applies at every
 * creation anyway; the page follows it so as to offer only what the service
 * will accept, and tests/agreement-page.test.ts, on the service side, confronts
 * the two.
 */
export function canHaveGuests(site: Pick<Site, "portal">): boolean {
  return site.portal.wanted && site.portal.installed
}

/** The sites where an access can be created, by slug. */
export function sitesWithGuests<T extends PortalSite>(sites: readonly T[]): T[] {
  return sites.filter(canHaveGuests).sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * The site already chosen when the creation opens: the one asked for if it can
 * take guests, the only one that can if there is just one, none otherwise. A
 * choice wrongly imposed would create an access on the wrong site.
 */
export function initialHost(hosts: readonly string[], requested: string | null = null): string {
  if (requested !== null && hosts.includes(requested)) return requested
  return hosts.length === 1 ? (hosts[0] ?? "") : ""
}

// --- The order of the list -------------------------------------------------------

function compareActive(a: Guest, b: Guest): number {
  if (a.expiresAt !== b.expiresAt) {
    if (a.expiresAt === null) return 1
    if (b.expiresAt === null) return -1
    return a.expiresAt - b.expiresAt
  }
  return a.label.localeCompare(b.label)
}

/**
 * The active accesses, from the closest to its end to the furthest, the ones
 * with no expiry last; then the expired ones, the most recently lapsed first.
 * An expired access opens nothing any more, but the portal keeps it until it is
 * removed: so it is shown, on its own.
 */
export function splitGuests(guests: readonly Guest[], now: number): { active: Guest[]; expired: Guest[] } {
  const active: Guest[] = []
  const expired: Guest[] = []
  for (const guest of guests) {
    if (guest.expiresAt !== null && guest.expiresAt <= now) expired.push(guest)
    else active.push(guest)
  }
  active.sort(compareActive)
  expired.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))
  return { active, expired }
}

/** The accesses of a single site, split the same way: the site's Guests section shows them. */
export function siteGuests(
  guests: readonly Guest[],
  host: string,
  now: number,
): { active: Guest[]; expired: Guest[] } {
  return splitGuests(
    guests.filter((guest) => guest.host === host),
    now,
  )
}

/**
 * The number of active accesses for each host: a site's row, on the home page,
 * states it next to its door. A host with no active access does not appear.
 */
export function activeByHost(guests: readonly Guest[] | null, now: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (const guest of splitGuests(guests ?? [], now).active) {
    counts.set(guest.host, (counts.get(guest.host) ?? 0) + 1)
  }
  return counts
}

/**
 * Where to send focus when a row disappears: the following rows in displayed
 * order, then the preceding ones going back up. The page takes the first of
 * these accesses whose button is still on screen.
 */
export function focusCandidates(order: readonly string[], id: string): string[] {
  const index = order.indexOf(id)
  if (index < 0) return [...order]
  return [...order.slice(index + 1), ...order.slice(0, index).reverse()]
}

// --- What a row says -------------------------------------------------------------

export type Expiry = { text: string; tone: "normal" | "soon" | "none" | "expired" }

export function deadline(guest: Pick<Guest, "expiresAt">, now: number): Expiry {
  if (guest.expiresAt === null) return { text: "No expiry", tone: "none" }
  const remaining = guest.expiresAt - now
  if (remaining <= 0) return { text: `Expired ${ago(-remaining)}`, tone: "expired" }
  return { text: fromNow(remaining), tone: remaining < EXPIRY_SOON_MS ? "soon" : "normal" }
}

/** The expiry as a date and time, beside its relative form; nothing for an access with no expiry. */
export function endDate(guest: Pick<Guest, "expiresAt">, timeZone?: string): string | null {
  return guest.expiresAt === null ? null : dateTime(guest.expiresAt, timeZone)
}

export function lastVisit(guest: Pick<Guest, "seenAt">, now: number): string {
  return guest.seenAt === null ? "Never" : ago(now - guest.seenAt)
}

/**
 * An access's activity line where there are no columns, on a phone and on a
 * site's Overview: "Visited 2h ago, created 7d ago".
 */
export function guestActivity(guest: Pick<Guest, "seenAt" | "createdAt">, now: number): string {
  const visit = guest.seenAt === null ? "Never visited" : `Visited ${ago(now - guest.seenAt)}`
  return `${visit}, created ${ago(now - guest.createdAt)}`
}

/** The header's count: the accesses that still open something. */
export function activeCount(active: number): string {
  return `${active} active`
}

// --- The creation ----------------------------------------------------------------

/**
 * What the chosen duration gives, said under the choice before creating: the
 * exact end date, or the fact that there is none.
 */
export function plannedEnd(seconds: number | null, now: number, timeZone?: string): string {
  if (seconds === null) return "Stays valid until you revoke it."
  return `Ends ${dateTime(now + seconds * 1000, timeZone)}.`
}

/**
 * What "Copy invitation" puts on the clipboard: enough to get in, ready to
 * paste into a message. The expiry is written only if there is one.
 */
export function invitationText(host: string, password: string, expiresAt: number | null, timeZone?: string): string {
  const lines = [`https://${host}`, `Password: ${password}`]
  if (expiresAt !== null) lines.push(`Valid until ${dateTime(expiresAt, timeZone)}`)
  return lines.join("\n")
}

/**
 * The password is never shown again. Closing its screen without having copied
 * it therefore takes two gestures: the first warns, the second closes.
 */
export function closeOutcome(copied: boolean, warned: boolean): "closeButton" | "warn" {
  return copied || warned ? "closeButton" : "warn"
}

export type Field = "site" | "label" | "duration"

export type FieldErrors = Partial<Record<Field, string>>

const LABEL_REFUSAL = `Use ${LABEL_MAX} characters at most, on one line.`

/**
 * Validation on submit, with the portal's own rule for the label: what the page
 * accepts, the portal will accept.
 */
export function validateInvitation(host: string, label: string, hosts: readonly string[]): FieldErrors {
  const errors: FieldErrors = {}
  if (!hosts.includes(host)) errors.site = "Choose a site."
  if (cleanLabel(label) === null) {
    errors.label = label.trim() === "" ? "Enter the guest's name." : LABEL_REFUSAL
  }
  return errors
}

/** The first faulty field in form order, where focus goes. */
export function firstField(errors: FieldErrors): Field | null {
  return (["site", "label", "duration"] as const).find((field) => errors[field] !== undefined) ?? null
}

// --- The refusals ----------------------------------------------------------------

export type Refusal = { field: Field | null; message: string }

/**
 * What a refusal means. The codes stay the API's, returned by `src/routes.ts`
 * or relayed from the portal: only the message is translated, attached to the
 * faulty field when there is one, and an unknown code is shown as is rather
 * than vanishing.
 */
export function guestRefusal(status: number, body: { error?: string } | null): Refusal {
  if (status === 0) return { field: null, message: "Can't reach the dashboard." }
  if (status === 502) return { field: null, message: "Can't reach the portal." }
  switch (body?.error) {
    case "no-portal":
      return { field: "site", message: "This site is not behind the portal." }
    case "invalid-label":
      return { field: "label", message: LABEL_REFUSAL }
    case "invalid-duration":
      return { field: "duration", message: "This duration is not accepted." }
    case "unknown-access":
      return { field: null, message: "This access no longer exists." }
    case "origin-refused":
      return { field: null, message: "Origin not allowed." }
  }
  return { field: null, message: `Refused (${status}${body?.error ? `: ${body.error}` : ""}).` }
}

const DASHBOARD_UNREACHABLE = "Can't reach the dashboard."

/** Why the list could not load: the dashboard unreachable, or the portal behind it. */
export function loadFailureReason(status: number): string {
  return status === 0 ? DASHBOARD_UNREACHABLE : "Can't reach the portal."
}

/**
 * What to do when the list is missing, depending on the reason: check your
 * connection if the dashboard did not answer, look at the portal's service
 * otherwise. The portal holds the accesses, and it is also what lets people in
 * on the protected sites.
 */
export function loadAdvice(reason: string): { text: string; command: string | null } {
  if (reason === DASHBOARD_UNREACHABLE) {
    return { text: "The server didn't answer. Check your connection, then try again.", command: null }
  }
  return {
    text: "The portal, which keeps guest access, didn't answer. Sites behind it may be closed too. Check",
    command: "systemctl status portal",
  }
}
