/**
 * The sidebar: its remembered collapsed state, and what each entry reports, at
 * the machine level as inside a site. Pure: the storage arrives as a parameter,
 * and so does the data.
 */
import { readPortal } from "./access"
import { splitGuests } from "./invitations"
import type { Guest } from "./guests"
import type { MachinePage, Section } from "./pages"
import { fileProblems } from "./secrets"
import { siteAccess, serviceSummaryOf } from "./sites"
import type { Tone } from "./tones"
import type { Discrepancy, PortalView, ProjectView, Site } from "./types"

/**
 * The collapse key, `"1"` when the sidebar is collapsed, absent otherwise. The
 * inline script in layouts/main.astro reads it back before the first render,
 * and tests/sidebar.test.ts runs it against these functions.
 */
export const SIDEBAR_KEY = "sidebar-collapsed"

/** `localStorage` can throw on mere access: the sidebar then stays expanded. */
export function readCollapsed(storage: () => Pick<Storage, "getItem">): boolean {
  try {
    return storage().getItem(SIDEBAR_KEY) === "1"
  } catch {
    return false
  }
}

/** Returns false if storage refuses: the collapse then holds for this page only. */
export function storeCollapsed(storage: () => Pick<Storage, "setItem" | "removeItem">, collapsed: boolean): boolean {
  try {
    if (collapsed) storage().setItem(SIDEBAR_KEY, "1")
    else storage().removeItem(SIDEBAR_KEY)
    return true
  } catch {
    return false
  }
}

/** The collapse shortcut to display, the one `SidebarProvider` listens for on each system. */
export function sidebarShortcut(agent: string): string {
  return /Mac|iPhone|iPad/.test(agent) ? "⌘B" : "Ctrl+B"
}

export type Indicator = { count: number; tone: Tone; label: string }

function plural(count: number, singular: string, many: string): string {
  return `${count} ${count === 1 ? singular : many}`
}

/** An app service that is not running, as the site's row shows it in red. */
export function downServices(sites: readonly Site[], now: number): number {
  return sites.filter((site) => site.type === "app" && serviceSummaryOf(site, now).kind === "stopped").length
}

/** The discrepancy count, in error if there is one, in attention otherwise. Nothing with no discrepancy. */
function discrepancyIndicator(discrepancies: readonly Discrepancy[] | null): Indicator | null {
  if (discrepancies === null || discrepancies.length === 0) return null
  const error = discrepancies.some((discrepancy) => discrepancy.severity === "error")
  return { count: discrepancies.length, tone: error ? "error" : "attention", label: plural(discrepancies.length, "refusal", "issues") }
}

/**
 * The entries of the machine level. The home page carries the whole machine's
 * discrepancies, which is what makes you open the dashboard; the activity
 * reports nothing, it is read when you go looking for it. Zero is not shown.
 */
export function machineIndicators(discrepancies: readonly Discrepancy[] | null): Record<MachinePage, Indicator | null> {
  return { home: discrepancyIndicator(discrepancies), activity: null }
}

export type SiteSources = {
  /** This site's discrepancies alone; null until a snapshot has arrived. */
  discrepancies: readonly Discrepancy[] | null
  /** The steward's project; null until it has been read. */
  project: ProjectView | null
  /** The site in the snapshot, for its door; null if it is not there. */
  site: Pick<Site, "portal" | "lock"> | null
  /** This site's guest accesses alone; null until they have been read. */
  guests: readonly Guest[] | null
  now: number
  /** The server's time, against which the steward's dates are compared. */
  serverNow: number
}

/** The steward's portal if it has been read, the snapshot's otherwise: a disagreement has to show from both. */
function gateDisagrees(project: ProjectView | null, site: Pick<Site, "portal" | "lock"> | null): boolean {
  const portal: Pick<PortalView, "requested" | "installed"> | null = project?.portal ?? null
  if (portal !== null && readPortal(portal, "").tone === "error") return true
  return site !== null && siteAccess(site).kind === "mismatch"
}

/**
 * A site's sections, each with what makes you open it: its discrepancies for
 * Overview, what its files ask for in Secrets (a missing file as an error,
 * unmanaged or restart pending as attention), its active guests for Guests, a
 * door in disagreement for Access. Zero is not shown.
 */
export function siteIndicators(sources: SiteSources): Record<Section, Indicator | null> {
  const { discrepancies, project, site, guests, now, serverNow } = sources

  let secrets: Indicator | null = null
  if (project !== null) {
    const problems = fileProblems(project, serverNow)
    if (problems.length > 0) {
      const error = problems.some((problem) => problem.tone === "error")
      const label = problems.map((problem) => problem.label.toLowerCase()).join(", ")
      secrets = { count: problems.length, tone: error ? "error" : "attention", label }
    }
  }

  const active = guests === null ? 0 : splitGuests(guests, now).active.length
  const guestsIndicator: Indicator | null =
    active > 0 ? { count: active, tone: "neutral", label: plural(active, "active guest", "active guests") } : null

  const access: Indicator | null = gateDisagrees(project, site)
    ? { count: 1, tone: "error", label: "the gate disagrees with sitesolide.json" }
    : null

  // Audience reports nothing: it is looked at, not watched over, and a pill on
  // a traffic figure would cry wolf every Monday.
  return { overview: discrepancyIndicator(discrepancies), audience: null, secrets, guests: guestsIndicator, access }
}
