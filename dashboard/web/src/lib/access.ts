/**
 * What a site's Access section decides on its own: what the portal's state
 * says, the actions it offers, what they announce, the wait for their result,
 * and the preview lock's commands. Pure.
 *
 * No gatekeeper rule here: `modifiable` and `reason` come from the steward,
 * which alone knows which site may change its door, and its refusal is shown as
 * is. The page only turns the state into words, and offers an action only if
 * the steward said it was possible.
 */
import type { Tone } from "./tones"
import type { PortalView, Site } from "./types"

// --- The portal's state ---------------------------------------------------------

export type PortalReading = {
  tone: Tone
  title: string
  detail: string
  /** What sitesolide.json asks for, what the live Caddy block applies, and the tone of their agreement. */
  requested: string
  applied: string
  checkTone: Tone
  /** The portal guards the site, or is asked to: its public paths mean something. */
  guards: boolean
}

/**
 * A site's portal state in words. A disagreement between the manifest and the
 * live block comes before everything else, as on the site's row: it is what
 * leaves a site open when you believe it closed.
 */
export function readPortal(portal: Pick<PortalView, "requested" | "installed">, slug: string): PortalReading {
  const { requested, installed } = portal
  const checkTone: Tone = requested !== installed ? "error" : installed ? "ok" : "neutral"
  const check = {
    requested: requested ? "Requested" : "Not requested",
    applied: installed ? "Applied by the live Caddy block" : "Not in the live Caddy block",
    checkTone,
    guards: requested || installed,
  }
  if (requested && installed) {
    return {
      tone: "ok",
      title: "Portal on",
      detail: `Visitors sign in through the shared portal before they reach ${slug}.`,
      ...check,
    }
  }
  if (!requested && !installed) {
    return {
      tone: "neutral",
      title: "Portal off",
      detail: `${slug} doesn't send visitors through the portal.`,
      ...check,
    }
  }
  if (requested) {
    return {
      tone: "error",
      title: "Portal requested but not applied",
      detail:
        "sitesolide.json asks for the portal, but the live Caddy block doesn't apply it: anyone can reach the site.",
      ...check,
    }
  }
  return {
    tone: "error",
    title: "Portal applied but not requested",
    detail:
      "The live Caddy block applies the portal, but sitesolide.json no longer asks for it. The site stays closed.",
    ...check,
  }
}

/**
 * The portal as the snapshot sees it, when the steward has not answered: enough
 * to read the state, never enough to act, since only the steward says what can
 * be changed.
 */
export function portalFromSnapshot(site: Pick<Site, "portal">): PortalView {
  return { requested: site.portal.wanted, installed: site.portal.installed, modifiable: false, reason: null }
}

// --- The actions -----------------------------------------------------------------

export type PortalAction = { active: boolean; label: string; main: boolean }

const TURN_ON: PortalAction = { active: true, label: "Turn on portal", main: true }
const TURN_OFF: PortalAction = { active: false, label: "Turn off portal", main: true }

/**
 * The actions to offer, the primary one first. None without the steward's
 * agreement. In disagreement, both: turning the portal on closes the site and
 * brings the two sides back into agreement, so it comes first; turning it off
 * agrees them too, by opening the site.
 */
export function portalActions(portal: PortalView): PortalAction[] {
  if (!portal.modifiable) return []
  if (portal.requested && portal.installed) return [TURN_OFF]
  if (!portal.requested && !portal.installed) return [TURN_ON]
  return [TURN_ON, { ...TURN_OFF, main: false }]
}

/**
 * The slug retyped to turn the portal off, without the blanks of a thumb-typed
 * entry. The button only acts on an exact match; the steward checks it anyway,
 * and it is this text that is sent.
 */
export function removalConfirmation(entry: string): string {
  return entry.trim()
}

export function confirmationValid(entry: string, slug: string): boolean {
  return removalConfirmation(entry) === slug
}

export type ToggleTexts = {
  title: string
  consequence: string
  action: string
  actionEnCours: string
  runningTitle: string
  succeeded: string
  failure: string
}

/** What the confirmation, the wait and the result of a portal action say. */
export function toggleTexts(slug: string, active: boolean): ToggleTexts {
  if (active) {
    return {
      title: `Turn on the portal for ${slug}?`,
      consequence: `Visitors will sign in through the shared portal before they reach ${slug}. Guests can then be given their own password for it.`,
      action: "Turn on portal",
      actionEnCours: "Turning on…",
      runningTitle: `Turning on the portal for ${slug}…`,
      succeeded: `The portal is on for ${slug}`,
      failure: `Couldn't turn on the portal for ${slug}`,
    }
  }
  return {
    title: `Turn off the portal for ${slug}?`,
    consequence: `The portal stops guarding ${slug}, and guest passwords are no longer asked.`,
    action: "Turn off portal",
    actionEnCours: "Turning off…",
    runningTitle: `Turning off the portal for ${slug}…`,
    succeeded: `The portal is off for ${slug}`,
    failure: `Couldn't turn off the portal for ${slug}`,
  }
}

/**
 * What the gatekeeper does during the wait, in order, as the contract describes
 * it. The page does not know how far it has got, so it ticks nothing off: it
 * states the sequence of steps and the time elapsed.
 */
export function gatekeeperSteps(slug: string): string[] {
  return ["Validate the whole Caddy configuration", "Reload Caddy", `Check that ${slug} answers as it should`]
}

/** What is written by hand after a successful action: the repository has to follow the machine. */
export const DEPLOY_COMMAND = "sitesolide deploy"

// --- The wait --------------------------------------------------------------------

/**
 * The track's scale: the longest answer the relay waits for from the steward,
 * `MAX_PORTAL_MS` in the protocol. The page cannot import that value;
 * tests/access.test.ts reads it back from the protocol.
 */
export const PORTAL_SCALE_MS = 90_000

/** Beyond this, the page says it is taking longer than usual, promising nothing. */
export const PORTAL_SLOW_MS = 30_000

export type PortalProgress = { part: number; elapsed: string; slow: boolean }

/** The time actually elapsed on the track, never an invented progress. */
export function portalProgress(elapsedMs: number): PortalProgress {
  const borne = Math.max(0, elapsedMs)
  return {
    part: Math.min(1, borne / PORTAL_SCALE_MS),
    elapsed: `${Math.floor(borne / 1000)}s`,
    slow: borne >= PORTAL_SLOW_MS,
  }
}

// --- The preview lock ------------------------------------------------------------

export type LockCommand = { label: string; command: string }

/**
 * The lock is set and removed from the workstation, through `bin/lock.sh`,
 * which generates the code and shows it once: the dashboard only displays it.
 */
export function lockCommands(slug: string, closed: boolean): LockCommand[] {
  if (!closed) return [{ label: "Set a preview lock", command: `bin/lock.sh enable ${slug}` }]
  return [
    { label: "Replace the code", command: `bin/lock.sh code ${slug}` },
    { label: "Remove the lock", command: `bin/lock.sh disable ${slug}` },
  ]
}
