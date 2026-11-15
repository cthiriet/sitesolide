/**
 * What a site's Access section decides on its own: the state of its general
 * access and what may be chosen there, what giving a guest access will do
 * before it is sent, how each guest reads, and the waits around them. Pure.
 *
 * The rules are the steward's (dashboard/src/access/rules.ts): it judges
 * every change and the page shows its refusal as it stands. The page reads
 * an email with the very function the steward does (borrowed/email.ts).
 * `modifiable` and `reason` for general access come from the steward too:
 * only it knows which site may change.
 */
import { cleanEmail } from "../../../borrowed/email"
import { ago, dateTime, duration } from "./format"
import { siteAccess } from "./sites"
import type { Tone } from "./tones"
import type { AccessPageResponse, EntryView, GeneralAccess, GeneralView, Site } from "./types"

// --- General access ------------------------------------------------------------------

export type GeneralChoice = { access: GeneralAccess; title: string; sentence: string }

/** The three ways a site opens, in the order shown. */
export const GENERAL_CHOICES: readonly GeneralChoice[] = [
  { access: "public", title: "Public", sentence: "Anyone with the address can open the site." },
  { access: "restricted", title: "Restricted", sentence: "Only you and the guests you give a password can open it." },
  { access: "code", title: "Anyone with the code", sentence: "Anyone who has the preview code can open it." },
]

/** sitesolide.json and the server disagree: what it means, in words. */
export type GeneralProblem = { title: string; detail: string }

export type GeneralState = {
  /** How the site opens right now, as the server serves it. */
  current: GeneralAccess
  /** What the manifest on the server asks for; it differs from `current` in a disagreement. */
  requested: GeneralAccess
  problem: GeneralProblem | null
  /** The paths a restricted site leaves to the app alone, `portalExempt` in sitesolide.json. */
  exemptions: string[]
  /** The preview code and the link that carries it, when the site opens with one. */
  code: { code: string; url: string | null } | null
}

/**
 * A site's general access from the snapshot: what the server does, and a
 * disagreement with sitesolide.json said first, since it is what leaves a
 * site open when you believe it restricted, or with a code nobody asked for.
 */
export function generalState(site: Pick<Site, "portal" | "lock">): GeneralState {
  const access = siteAccess(site)
  const exemptions = site.portal.exemptions
  const code = site.lock.code === null ? null : { code: site.lock.code, url: site.lock.url }
  switch (access.kind) {
    case "portal":
      return { current: "restricted", requested: "restricted", problem: null, exemptions, code: null }
    case "code":
      return { current: "code", requested: "code", problem: null, exemptions: [], code }
    case "open":
      return { current: "public", requested: "public", problem: null, exemptions: [], code: null }
    case "mismatch":
      switch (access.key) {
        case "portal-absent":
          return {
            current: "public",
            requested: "restricted",
            problem: { title: "Restricted in sitesolide.json, public on the server", detail: "Anyone can open it right now. Choose one below." },
            exemptions,
            code: null,
          }
        case "portal-extra":
          return {
            current: "restricted",
            requested: "public",
            problem: { title: "Restricted on the server, public in sitesolide.json", detail: "Choose one below." },
            exemptions,
            code: null,
          }
        case "code-without-lock":
          return {
            current: "code",
            requested: "public",
            problem: { title: "A code on the server, none in sitesolide.json", detail: "A preview code is in effect, but sitesolide.json no longer asks for one. Choose one below." },
            exemptions: [],
            code,
          }
        case "lock-without-code":
          return {
            current: "public",
            requested: "code",
            problem: { title: "A code in sitesolide.json, none on the server", detail: "sitesolide.json asks for a preview code, but the server has no valid one. Choose one below." },
            exemptions: [],
            code: null,
          }
      }
  }
}

export type ChoiceOption = GeneralChoice & {
  /** The site opens this way now. */
  current: boolean
  /** It may be chosen here, now. */
  available: boolean
  /** What its button says when it may: Make public, Restrict, Use a code; in a disagreement, Keep or Apply. */
  action: string | null
  /** In a disagreement between the server and sitesolide.json, which side this choice is. */
  side: "On the server" | "In sitesolide.json" | null
  /** Why the steward refuses this one here, said under it; null when it may, or when the reason is said once for all. */
  reason: string | null
}

/** What a choice's button says it will do, outside a disagreement. */
const ACTIONS: Record<GeneralAccess, string> = { public: "Make public", restricted: "Restrict", code: "Use a code" }

/** What the steward says may change, as the page reads it: each choice and its refusal, or nothing yet. */
export type StewardChoices = { choices: Readonly<Record<GeneralAccess, string | null>> } | null

/**
 * The steward's view, read for the page: its choices when it says them, or,
 * from a steward that predates the code being chosen here, Public and
 * Restricted as `modifiable` said, and the code as the CLI's.
 */
export function stewardChoices(view: GeneralView | null): StewardChoices {
  if (view === null) return null
  if (view.choices !== undefined) return { choices: view.choices }
  const shared = view.modifiable ? null : (view.reason ?? "It can't change from here.")
  return { choices: { public: shared, restricted: shared, code: "This server sets a code with sitesolide lock: run sitesolide upgrade to choose it here." } }
}

/**
 * The one reason the steward gives for every choice but the current one, when
 * it is the same for all: a change in progress, an interrupted one, the
 * platform's own site. Said once under the choices rather than on each row.
 */
export function sharedReason(state: GeneralState, steward: StewardChoices): string | null {
  if (steward === null) return null
  const others = GENERAL_CHOICES.filter((choice) => choice.access !== state.current).map((choice) => steward.choices[choice.access])
  const first = others[0] ?? null
  return first !== null && others.every((reason) => reason === first) ? first : null
}

/**
 * What each choice offers: the three change here, through the steward and
 * the gatekeeper. `steward` is null until the steward has said whether
 * the site may change; a refusal it gives for one choice is said under it,
 * one it gives for all once under the choices (`sharedReason`). In a
 * disagreement between the server and sitesolide.json, each side may be
 * chosen, and either brings them together.
 */
export function generalOptions(state: GeneralState, steward: StewardChoices): ChoiceOption[] {
  const disagreement = state.problem !== null
  const shared = sharedReason(state, steward)
  return GENERAL_CHOICES.map((choice) => {
    const current = choice.access === state.current
    const side = !disagreement ? null : current ? "On the server" : choice.access === state.requested ? "In sitesolide.json" : null
    const base: ChoiceOption = { ...choice, current, available: false, action: null, side, reason: null }
    if (current && !disagreement) return base
    if (steward === null) return base
    const refusal = steward.choices[choice.access]
    if (refusal !== null) return { ...base, reason: refusal === shared ? null : refusal }
    const action = side === null ? ACTIONS[choice.access] : `${current ? "Keep" : "Apply"} ${choice.title}`
    return { ...base, available: true, action }
  })
}

/** May the site that opens with a code be given a new one, here, now? */
export function mayRenew(state: GeneralState, steward: StewardChoices): boolean {
  return state.current === "code" && state.problem === null && steward !== null && steward.choices.code === null
}

/** What changing general access may aim at: one of the three, or a new code. */
export type ChangeTarget = GeneralAccess | "renew"

export type ChangeTexts = {
  title: string
  /** Said first, in red, before letting more people in: what it opens. */
  warning: string | null
  consequence: string
  action: string
  actionInProgress: string
  runningTitle: string
  succeeded: string
  failure: string
  /** The slug retyped before it goes: making a site public, or opening it with a code. */
  typed: boolean
}

/**
 * Every address a site answers on: its preview, and its own domain once it is
 * switched to. A change of general access applies to all of them at once.
 */
export function siteAddresses(site: Pick<Site, "address" | "domain">): string[] {
  return site.domain !== null && site.domain.active ? [site.address, site.domain.name] : [site.address]
}

/** The sentence that names them, when there is more than the preview to name. */
export function addressesLine(addresses: readonly string[]): string | null {
  return addresses.length > 1 ? `Applies to every address it answers on: ${addresses.join(" and ")}.` : null
}

/**
 * What the confirmation, the wait and the result of a change of general
 * access say. `from`, how the site opens now: leaving a code says the code
 * stops working. `addresses`, every address the site answers on, named when
 * there is more than the preview.
 */
export function changeTexts(slug: string, target: ChangeTarget, from: GeneralAccess = "public", addresses: readonly string[] = []): ChangeTexts {
  const texts = changeWords(slug, target, from)
  const line = target === "renew" ? null : addressesLine(addresses)
  return line === null ? texts : { ...texts, consequence: `${texts.consequence} ${line}` }
}

function changeWords(slug: string, target: ChangeTarget, from: GeneralAccess): ChangeTexts {
  const leavingCode = from === "code" && target !== "code" && target !== "renew"
  switch (target) {
    case "restricted":
      return {
        title: `Restrict ${slug}?`,
        warning: null,
        consequence: `${leavingCode ? "Its code stops working. " : ""}Only you and its guests will open ${slug}. Anyone else is asked to sign in, and refused.`,
        action: "Restrict",
        actionInProgress: "Restricting…",
        runningTitle: `Restricting ${slug}…`,
        succeeded: `${slug} is restricted`,
        failure: `Couldn't restrict ${slug}`,
        typed: false,
      }
    case "public":
      return {
        title: `Make ${slug} public?`,
        warning: "Anyone with its address can open it without signing in.",
        consequence: `${leavingCode ? "Its code is no longer asked. " : ""}Guests' passwords stop mattering until it is restricted again.`,
        action: "Make public",
        actionInProgress: "Making public…",
        runningTitle: `Making ${slug} public…`,
        succeeded: `${slug} is public`,
        failure: `Couldn't make ${slug} public`,
        typed: true,
      }
    case "code":
      return {
        title: `Use a code for ${slug}?`,
        warning: "Anyone who has the code can open it, without signing in.",
        consequence: "The server draws a ten-character code, shown here with a link that carries it. Guests' passwords stop mattering until it is restricted again.",
        action: "Use a code",
        actionInProgress: "Setting a code…",
        runningTitle: `Setting a code for ${slug}…`,
        succeeded: `${slug} opens with a code`,
        failure: `Couldn't set a code for ${slug}`,
        typed: true,
      }
    case "renew":
      return {
        title: `New code for ${slug}?`,
        warning: null,
        consequence: "The current code stops working at once, and the link that carries it. Send the new one to whoever should still open the site.",
        action: "New code",
        actionInProgress: "Drawing a new code…",
        runningTitle: `Drawing a new code for ${slug}…`,
        succeeded: `${slug} has a new code`,
        failure: `Couldn't give ${slug} a new code`,
        typed: false,
      }
  }
}

/** What the wait takes, said before it starts. */
export const CHANGE_DURATION = "Takes up to a minute. If anything fails, nothing changes."

/**
 * The gatekeeper's verdict in plain words: what the site now does, and that
 * the others still answer. Its own wording, `portal set: validated, reloaded,
 * <host> answers the portal's 401, 13 other site(s) still answer`, is shown
 * as it stands when it does not read that way.
 */
export function changeResult(target: ChangeTarget, detail: string): string {
  // One address, or the preview and the site's own domain, checked together.
  const found = /: validated, reloaded, (\S+)(?: and (\S+))? answers? /.exec(detail)
  if (found === null) return detail
  const host = found[2] === undefined ? found[1]! : `${found[1]} and ${found[2]}`
  const one = found[2] === undefined
  const first: Record<ChangeTarget, string> = {
    restricted: `${host} now ${one ? "asks" : "ask"} visitors to sign in.`,
    public: `${host} now ${one ? "opens" : "open"} without signing in.`,
    code: `${host} now ${one ? "asks" : "ask"} for its code.`,
    renew: `${host} ${one ? "opens" : "open"} with the new code; the old one no longer does.`,
  }
  const lines = [first[target]]
  const others = Number(/(\d+) other site\(s\) still answer/.exec(detail)?.[1] ?? 0)
  if (others === 1) lines.push("The other site still answers.")
  if (others > 1) lines.push(`The ${others} other sites still answer.`)
  const silent = /already not answering before: (.+)$/.exec(detail)?.[1]
  if (silent !== undefined) lines.push(`Already not answering before: ${silent}.`)
  return lines.join(" ")
}

/** After a change: the repository follows the machine at the next deploy. */
export const DEPLOY_NOTE = "Your next sitesolide deploy writes this into sitesolide.json."

/**
 * The slug retyped to make a site public or open it with a code, without the
 * blanks of a thumb-typed entry. The button only acts on an exact match; the
 * steward checks it anyway, and it is this text that is sent.
 */
export function removalConfirmation(entry: string): string {
  return entry.trim()
}

export function confirmationValid(entry: string, slug: string): boolean {
  return removalConfirmation(entry) === slug
}

/**
 * The track's scale: the longest answer the relay waits for from the steward,
 * `MAX_PORTAL_MS` in the protocol. The page cannot import that value;
 * tests/access.test.ts reads it back from the protocol.
 */
export const CHANGE_SCALE_MS = 90_000

/** Beyond this, the page says it is taking longer than usual, promising nothing. */
export const CHANGE_SLOW_MS = 30_000

export type ChangeProgress = { part: number; elapsed: string; slow: boolean }

/** The time actually elapsed on the track, never an invented progress. */
export function changeProgress(elapsedMs: number): ChangeProgress {
  const bounded = Math.max(0, elapsedMs)
  return { part: Math.min(1, bounded / CHANGE_SCALE_MS), elapsed: `${Math.floor(bounded / 1000)}s`, slow: bounded >= CHANGE_SLOW_MS }
}

// --- Guests --------------------------------------------------------------------------

/** How long a password access lasts, the steward's four (PASSWORD_DURATIONS_S), from the shortest. */
export const PASSWORD_DURATIONS: readonly { seconds: number | null; label: string }[] = [
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
  { seconds: 30 * 24 * 3600, label: "30 days" },
  { seconds: null, label: "No expiry" },
]

export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600

/** What the field holds, read the way the steward will read it (`readWho` in src/access/registry.ts). */
export type GuestPlan = {
  state: "empty" | "invalid" | "existing" | "ready"
  /** The email as the steward keeps it, lowercase. */
  who: string | null
  /** The line under the field. */
  hint: string
}

const EMPTY_HINT = "Their email. They get a password that opens this site, and nothing else."

/** What adding this text will do, said before it is sent. */
export function planGuest(text: string, entries: readonly Pick<EntryView, "who">[]): GuestPlan {
  const typed = text.trim()
  if (typed === "") return { state: "empty", who: null, hint: EMPTY_HINT }
  if (typed.startsWith("@")) return { state: "invalid", who: null, hint: "A whole domain can't be given access. Add one email at a time." }
  const email = cleanEmail(typed)
  if (email === null) return { state: "invalid", who: null, hint: "Enter an email, like name@example.com." }
  if (entries.some((entry) => entry.who === email)) return { state: "existing", who: email, hint: `${email} is already a guest.` }
  return { state: "ready", who: email, hint: EMPTY_HINT }
}

/** Who gave a guest access, in the quiet words of its row; null for what was carried over, whose giver was not kept. */
export function byText(by: string): string | null {
  if (by === "owner") return "you"
  if (by === "migration") return null
  if (by.startsWith("token:")) return "a token"
  return by
}

export type Expiry = { text: string; tone: Tone }

/** Within this, an expiry is worth a look. */
const EXPIRY_SOON_MS = 24 * 3600_000

/** A password access that has ended: it opens nothing, and its row says so. */
export function isExpired(entry: Pick<EntryView, "expiresAt" | "expired">, now: number): boolean {
  return entry.expired || (entry.expiresAt !== null && entry.expiresAt <= now)
}

/** A guest's expiry in words: "expires in 5d", "expired 2d ago", "no expiry". */
export function guestExpiry(entry: Pick<EntryView, "expiresAt" | "expired">, now: number): Expiry {
  if (entry.expiresAt === null) return { text: "No expiry", tone: "neutral" }
  const remaining = entry.expiresAt - now
  if (isExpired(entry, now)) return { text: `Expired ${ago(Math.max(0, -remaining))}`, tone: "neutral" }
  return { text: `Expires in ${duration(remaining)}`, tone: remaining < EXPIRY_SOON_MS ? "attention" : "neutral" }
}

/** "Given by you, 3d ago", or only when, for a guest carried over. */
export function givenText(entry: Pick<EntryView, "by" | "createdAt">, now: number): string {
  const by = byText(entry.by)
  return by === null ? `Given ${ago(now - entry.createdAt)}` : `Given by ${by}, ${ago(now - entry.createdAt)}`
}

/** The list in reading order: those who still open the site first, then by name. */
export function sortGuests(entries: readonly EntryView[], now: number): EntryView[] {
  const ended = (entry: EntryView) => (isExpired(entry, now) ? 1 : 0)
  return [...entries].sort((a, b) => ended(a) - ended(b) || a.who.localeCompare(b.who, "en"))
}

/** How many guests, beside the way a site opens on its Overview: "No guests", "1 guest", "4 guests". */
export function guestCount(count: number): string {
  return count === 0 ? "No guests" : count === 1 ? "1 guest" : `${count} guests`
}

/**
 * Restricting a site with no guest: who will still open it, said in the
 * confirmation. Null when it has guests.
 */
export function emptyListWarning(slug: string, entries: number): string | null {
  return entries > 0 ? null : `${slug} has no guest yet: after this, only you can open it.`
}

/**
 * The platform's own projects, the steward's `reservedReason`
 * (src/control/policy.ts): none takes a guest. The page cannot import that
 * list; tests/access.test.ts reads it back from the policy.
 */
export const PLATFORM_SLUGS: readonly string[] = ["dashboard", "portal", "api", "landing", "www"]

/** Is this project part of the platform: one of its own, or the landing, named after the zone. */
export function isPlatform(slug: string, zone: string | null): boolean {
  return PLATFORM_SLUGS.includes(slug) || (zone !== null && zone !== "" && slug === zone)
}

/** What a platform project's Access says, in place of its guests. */
export function platformText(slug: string): string {
  return `${slug} is part of the platform. Only you open it when restricted; it takes no guest.`
}

/** What "Copy message" puts on the clipboard: the address, the password, the expiry if any. */
export function passwordMessage(url: string, password: string, expiresAt: number | null, timeZone?: string): string {
  const lines = [url, `Password: ${password}`]
  if (expiresAt !== null) lines.push(`Valid until ${dateTime(expiresAt, timeZone)}`)
  return lines.join("\n")
}

/** What a chosen duration gives, said before adding: the exact end, or none. */
export function plannedEnd(seconds: number | null, now: number, timeZone?: string): string {
  return seconds === null ? "Valid until you remove it." : `Valid until ${dateTime(now + seconds * 1000, timeZone)}.`
}

/**
 * The password is never shown again. Closing its screen without having copied
 * it therefore takes two gestures: the first warns, the second closes.
 */
export function closeOutcome(copied: boolean, warned: boolean): "close" | "warn" {
  return copied || warned ? "close" : "warn"
}

/** What guests change while the site is not restricted: nothing yet. Null when it is restricted. */
export function inertNote(slug: string, current: GeneralAccess): string | null {
  if (current === "restricted") return null
  const how = current === "public" ? "is public" : "opens with its preview code"
  return `${slug} ${how}: guests' passwords only matter once it's restricted.`
}

/** The access service on the server did not answer: what the page says, and what to do. */
export const ACCESS_UNREACHABLE = "Can't reach the access service on the server. Retry in a moment; if it persists, run sitesolide status."

/** A refusal of the steward's or the service's, in words. */
export function refusalText(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 0) return "Can't reach the dashboard. Check your connection."
  if (typeof body?.message === "string" && body.message !== "") return body.message
  if (body?.error === "origin-refused") return "Origin not allowed."
  return `Refused (${status}).`
}

/**
 * What the portal on the machine reads, when it is worth a word: one that
 * cannot read the projection opens nothing from this list.
 */
export function readingProblem(portal: AccessPageResponse["portal"]): { tone: "attention" | "error"; text: string } | null {
  switch (portal.reading) {
    case "unreadable":
      return { tone: "error", text: "The portal can't read the guest list: no guest opens a restricted site until it can. Run sitesolide upgrade, then sitesolide status." }
    default:
      return null
  }
}
