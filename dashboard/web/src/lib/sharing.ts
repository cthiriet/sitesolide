/**
 * What the Sharing section decides inside the page: which sites can be
 * shared, what each mode means, how typed addresses become a list, what a
 * refusal says, and the line to send to someone. Pure.
 *
 * The rules of an email, a domain and a mode are the portal's own, borrowed
 * like guest durations: `borrowed/sharing.ts` is pure, with no import and no
 * call to Bun, and the page refuses an address with the exact rule the portal
 * will apply.
 */
import {
  DEFAULT_POLICY,
  DOMAINS_MAX,
  PEOPLE_MAX,
  SHARING_MODES,
  cleanDomain,
  cleanEmail,
  type Policy,
  type SharingMode,
} from "../../../borrowed/sharing"
import type { Site } from "./types"

export { DEFAULT_POLICY, DOMAINS_MAX, PEOPLE_MAX, SHARING_MODES, cleanDomain, cleanEmail, type Policy, type SharingMode }

/** How people sign in, as the portal says it: never the client's secret nor its identifier. */
export type SsoView = {
  configured: boolean
  providerName: string | null
  portalUrl: string | null
  admins: string[]
  allowedDomains: string[]
}

export type SharedSite = { host: string; policy: Policy; updatedAt: number }

export type SharingList = { sso: SsoView; sites: SharedSite[] }

// --- The sites that can be shared ------------------------------------------------

/**
 * Sharing only means something on a site whose live block carries the portal:
 * the rule of `invitableHosts` in src/guests.ts, which the service applies to
 * every change anyway.
 */
export function canShare(site: Pick<Site, "portal">): boolean {
  return site.portal.wanted && site.portal.installed
}

/**
 * Does the site's app learn who signed in? `null` when the snapshot does not
 * say, written by a collector from before identities.
 */
export function identityPassed(site: Pick<Site, "portal">): boolean | null {
  return site.portal.identity ?? null
}

/** The site's policy, the narrowest one if it was never set. */
export function sitePolicy(list: SharingList, host: string): { policy: Policy; updatedAt: number | null } {
  const found = list.sites.find((entry) => entry.host === host)
  return found === undefined ? { policy: DEFAULT_POLICY, updatedAt: null } : { policy: found.policy, updatedAt: found.updatedAt }
}

// --- What a mode means -----------------------------------------------------------

export const MODE_TEXTS: Readonly<Record<SharingMode, { title: string; description: string }>> = {
  admins: { title: "Only admins", description: "You, the admin emails, and guests with a password." },
  people: { title: "Specific people", description: "Plus the people you add, by their work email." },
  domain: { title: "Everyone at a domain", description: "Plus everyone whose work email is at a domain you add." },
}

/** Which lists a mode puts in effect: the others are kept for later, and say so. */
export function listsInEffect(mode: SharingMode): { people: boolean; domains: boolean } {
  return { people: mode !== "admins", domains: mode === "domain" }
}

/** The policy in a few words, for the panel's header: "3 people", "acme.test and 2 people". */
export function policySummary(policy: Policy): string {
  if (policy.mode === "admins") return "Admins only"
  const people = policy.people.length === 1 ? "1 person" : `${policy.people.length} people`
  if (policy.mode === "people") return people
  const domains = policy.domains.length === 0 ? "no domain" : policy.domains.length === 1 ? policy.domains[0]! : `${policy.domains.length} domains`
  return policy.people.length === 0 ? domains : `${domains} and ${people}`
}

// --- Adding to a list ------------------------------------------------------------

export type Addition = { values: string[]; error: string | null }

/**
 * What a typed line adds to a list: one entry or several, separated by commas,
 * spaces or line breaks, each cleaned with the portal's rule. One bad entry
 * refuses the whole line, as the portal would refuse the whole policy, and the
 * error names it. An entry already there is not an error: it is simply there.
 */
export function addEntries(current: readonly string[], typed: string, kind: "people" | "domains"): Addition {
  const clean = kind === "people" ? cleanEmail : cleanDomain
  const max = kind === "people" ? PEOPLE_MAX : DOMAINS_MAX
  const entries = typed.split(/[\s,;]+/).filter((entry) => entry !== "")
  if (entries.length === 0) return { values: [...current], error: kind === "people" ? "Enter an email address." : "Enter a domain." }
  const values = new Set(current)
  for (const entry of entries) {
    const cleaned = clean(entry)
    if (cleaned === null) {
      return {
        values: [...current],
        error: kind === "people" ? `"${entry}" isn't an email address.` : `"${entry}" isn't a domain, like acme.com.`,
      }
    }
    values.add(cleaned)
  }
  if (values.size > max) return { values: [...current], error: `At most ${max} ${kind === "people" ? "people" : "domains"}.` }
  return { values: [...values].sort(), error: null }
}

// --- The refusals ----------------------------------------------------------------

/** What the page says when the portal answers but has no sharing to give: a portal from before it. */
export const PORTAL_TOO_OLD = "The portal doesn't know sharing yet."

/**
 * Why the policies could not load. A 404 relayed from the portal is a portal
 * deployed before sharing, which this dashboard outran: it says so, rather
 * than calling the portal unreachable while it answers.
 */
export function sharingLoadFailure(status: number): { title: string; advice: string } {
  if (status === 0) return { title: "Can't reach the dashboard.", advice: "The server didn't answer. Check your connection, then try again." }
  if (status === 404) {
    return { title: PORTAL_TOO_OLD, advice: "Deploy the portal from this release: cd portal && sitesolide deploy --force, see portal/README.md." }
  }
  return {
    title: "Can't reach the portal.",
    advice: "The portal, which keeps who may sign in, didn't answer. Sites behind it may be closed too. Check systemctl status portal on the server.",
  }
}

/** What a refusal means. The codes stay the API's; an unknown one is shown as is rather than vanishing. */
export function sharingRefusal(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 0) return "Can't reach the dashboard."
  // A Project admin's change goes through the steward, which says why in words.
  if (body?.error === "out-of-scope" && typeof body.message === "string") return body.message
  if (body?.error === "not-available" && typeof body.message === "string") return body.message
  if (status === 502) return "Can't reach the portal."
  if (status === 404 && body?.error === undefined) return PORTAL_TOO_OLD
  switch (body?.error) {
    case "no-portal":
      return "This site is not behind the portal."
    case "invalid-people":
      return "One of the email addresses is not accepted."
    case "invalid-domains":
      return "One of the domains is not accepted."
    case "invalid-mode":
      return "This sharing mode is not accepted."
    case "origin-refused":
      return "Origin not allowed."
  }
  return `Refused (${status}${body?.error ? `: ${body.error}` : ""}).`
}

// --- What to send ----------------------------------------------------------------

/**
 * The line to paste into a message: where to go, and with what. Nothing in it
 * opens the site by itself; the person still signs in, and gets in only if
 * the policy lets them.
 */
export function shareMessage(address: string, providerName: string | null): string {
  const account = providerName === null || providerName === "your work account" ? "your work account" : `your ${providerName} work account`
  return `Open https://${address} and sign in with ${account}.`
}
