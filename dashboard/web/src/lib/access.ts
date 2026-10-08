/**
 * What a site's Access section decides on its own: the words of the roles,
 * the state of its general access and what may be chosen there, what adding
 * someone will give before it is sent, how each person with access reads,
 * and the waits and commands around them. Pure.
 *
 * The rules are the steward's (dashboard/src/access/rules.ts): it judges
 * every change and the page shows its refusal as it stands. The page follows
 * the same rules only to offer what the steward will accept and to say why a
 * role is not offered, using the very functions the steward does for an
 * address and a domain (borrowed/sharing.ts) and the same ladder
 * (borrowed/access.ts). `modifiable` and `reason` for general access come
 * from the steward too: only it knows which site may change.
 */
import { ROLES, rank } from "../../../borrowed/access"
import { cleanDomain, cleanEmail, domainOf, maySignIn } from "../../../borrowed/sharing"
import { ago, dateTime, duration } from "./format"
import { siteAccess } from "./sites"
import type { Tone } from "./tones"
import type { AccessPageResponse, AccessRole, EntryView, GeneralAccess, Site } from "./types"

// --- The roles -----------------------------------------------------------------------

/** A role's name, what it can do as the ladder says it, and the same said to whoever holds it. */
export type RoleText = { label: string; can: string; yours: string }

/** Each rung of the ladder, in the words of the page, from the lowest: each includes the ones below. */
export const ROLE_TEXTS: Readonly<Record<AccessRole, RoleText>> = {
  visitor: { label: "Can open", can: "Opens the site when its access is restricted.", yours: "you open the site when its access is restricted" },
  viewer: { label: "Viewer", can: "Also sees the project here: its state, audience and activity.", yours: "you see the project here: its state, audience and activity" },
  developer: {
    label: "Developer",
    can: "Also deploys it, restarts it and writes its secrets, never reading one back.",
    yours: "you see the project, deploy it, restart it and write its secrets, never reading one back",
  },
  admin: { label: "Admin", can: "Also reads its secrets, changes its access and people, restores its backups.", yours: "you can do everything with the project" },
}

/** The one above every project, who is not on any list. */
export const OWNER_TEXT: RoleText = { label: "Owner", can: "Everything, on every project and on the server.", yours: "you can do everything" }

/** The ladder, from the lowest. */
export const LADDER: readonly AccessRole[] = ROLES

export function roleLabel(role: AccessRole): string {
  return ROLE_TEXTS[role].label
}

/** `blog: Developer, shop: Viewer`, sorted by project. */
export function rolesSummary(roles: Readonly<Record<string, AccessRole>>): string {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b, "en"))
  return entries.map(([slug, role]) => `${slug}: ${roleLabel(role)}`).join(", ")
}

// --- General access ------------------------------------------------------------------

export type GeneralChoice = { access: GeneralAccess; title: string; sentence: string }

/** The three ways a site opens, in the order shown. */
export const GENERAL_CHOICES: readonly GeneralChoice[] = [
  { access: "public", title: "Public", sentence: "Anyone with the address can open the site." },
  { access: "restricted", title: "Restricted", sentence: "Only the people with access can open it, once signed in." },
  { access: "code", title: "Anyone with the code", sentence: "Anyone who has the preview code can open it." },
]

export function generalTitle(access: GeneralAccess): string {
  return GENERAL_CHOICES.find((choice) => choice.access === access)?.title ?? access
}

/** sitesolide.json and the server disagree: what it means, in words. */
export type GeneralProblem = { title: string; detail: string; portal: boolean }

export type GeneralState = {
  /** How the site opens right now, as the server serves it. */
  current: GeneralAccess
  problem: GeneralProblem | null
  /** The paths a restricted site leaves to the app alone, `portalExempt` in sitesolide.json. */
  exemptions: string[]
  /** The preview code and the link that carries it, when the site opens with one. */
  code: { code: string; url: string | null } | null
}

/**
 * A site's general access from the snapshot: what the server does, and a
 * disagreement with sitesolide.json said first, since it is what leaves a
 * site open when you believe it restricted.
 */
export function generalState(site: Pick<Site, "portal" | "lock">): GeneralState {
  const access = siteAccess(site)
  const exemptions = site.portal.exemptions
  const code = site.lock.code === null ? null : { code: site.lock.code, url: site.lock.url }
  switch (access.kind) {
    case "portal":
      return { current: "restricted", problem: null, exemptions, code: null }
    case "code":
      return { current: "code", problem: null, exemptions: [], code }
    case "open":
      return { current: "public", problem: null, exemptions: [], code: null }
    case "mismatch":
      switch (access.key) {
        case "portal-absent":
          return {
            current: "public",
            problem: {
              title: "Restricted in sitesolide.json, public on the server",
              detail: "The live Caddy block doesn't restrict the site: anyone can open it. Choose Restricted to apply it, or Public to agree with the server.",
              portal: true,
            },
            exemptions,
            code: null,
          }
        case "portal-extra":
          return {
            current: "restricted",
            problem: {
              title: "Restricted on the server, not in sitesolide.json",
              detail: "The live Caddy block still restricts the site, but sitesolide.json no longer asks for it. Choose one to bring them together.",
              portal: true,
            },
            exemptions,
            code: null,
          }
        case "code-without-lock":
          return {
            current: "code",
            problem: {
              title: "A code on the server, none in sitesolide.json",
              detail: "A preview code is in effect, but sitesolide.json no longer asks for one. Remove it from the project's folder.",
              portal: false,
            },
            exemptions: [],
            code,
          }
        case "lock-without-code":
          return {
            current: "public",
            problem: {
              title: "A code in sitesolide.json, none on the server",
              detail: "sitesolide.json asks for a preview code, but the server has no valid one. Set it again from the project's folder.",
              portal: false,
            },
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
  /** Why it may not, when there is something to say: a command, or the steward's reason. */
  reason: string | null
  /** The command that does it instead, from the project's folder. */
  command: string | null
}

/**
 * What each choice offers. Public and restricted change here, through the
 * steward, for those who may change general access; a preview code is
 * `sitesolide lock`'s, from the project's folder, and while it is set the
 * other two wait for `sitesolide unlock`. `steward` is null until the
 * steward has said whether the site may change.
 */
export function generalOptions(
  state: GeneralState,
  steward: { modifiable: boolean; reason: string | null } | null,
  mayChange: boolean,
): ChoiceOption[] {
  return GENERAL_CHOICES.map((choice) => {
    const current = choice.access === state.current
    const base = { ...choice, current, available: false, reason: null, command: null }
    if (!mayChange) return base
    if (choice.access === "code") {
      return current ? base : { ...base, reason: "Given from the project's folder:", command: "sitesolide lock" }
    }
    // The commands that replace or remove the code are listed once, under the choices.
    if (state.current === "code") return { ...base, reason: "Remove the preview code first, from the project's folder." }
    // In disagreement, both sides may be chosen: either brings them together.
    if (current && state.problem?.portal !== true) return base
    if (steward === null) return base
    if (!steward.modifiable) return { ...base, reason: steward.reason }
    return { ...base, available: true }
  })
}

export type ChangeTexts = {
  title: string
  consequence: string
  action: string
  actionInProgress: string
  runningTitle: string
  succeeded: string
  failure: string
}

/** What the confirmation, the wait and the result of a change of general access say. */
export function changeTexts(slug: string, target: "public" | "restricted"): ChangeTexts {
  if (target === "restricted") {
    return {
      title: `Restrict ${slug}?`,
      consequence: `Only the people with access will open ${slug}, once signed in. Anyone else is asked to sign in, and refused.`,
      action: "Restrict",
      actionInProgress: "Restricting…",
      runningTitle: `Restricting ${slug}…`,
      succeeded: `${slug} is restricted`,
      failure: `Couldn't restrict ${slug}`,
    }
  }
  return {
    title: `Make ${slug} public?`,
    consequence: `Anyone with its address will open ${slug}, without signing in. The people with access keep their roles in the dashboard.`,
    action: "Make public",
    actionInProgress: "Making public…",
    runningTitle: `Making ${slug} public…`,
    succeeded: `${slug} is public`,
    failure: `Couldn't make ${slug} public`,
  }
}

/**
 * The slug retyped to make a site public, without the blanks of a
 * thumb-typed entry. The button only acts on an exact match; the steward
 * checks it anyway, and it is this text that is sent.
 */
export function removalConfirmation(entry: string): string {
  return entry.trim()
}

export function confirmationValid(entry: string, slug: string): boolean {
  return removalConfirmation(entry) === slug
}

/**
 * What the gatekeeper does during the wait, in order. The page does not know
 * how far it has got, so it ticks nothing off: it states the steps and the
 * time elapsed.
 */
export function gatekeeperSteps(slug: string): string[] {
  return ["Validate the whole Caddy configuration", "Reload Caddy", `Check that ${slug} answers as it should`]
}

/** What is written by hand after a change: the repository has to follow the machine. */
export const DEPLOY_COMMAND = "sitesolide deploy"

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
  const borne = Math.max(0, elapsedMs)
  return { part: Math.min(1, borne / CHANGE_SCALE_MS), elapsed: `${Math.floor(borne / 1000)}s`, slow: borne >= CHANGE_SLOW_MS }
}

export type CodeCommand = { label: string; command: string }

/**
 * A preview code is given and removed from the workstation, with the CLI run
 * in the project's folder, which draws the code and shows it once: the
 * dashboard only shows it. Never `bin/lock.sh`: that script is the binary's
 * own, and someone who installed the binary has no `bin/` to run it from.
 */
export function codeCommands(code: boolean): CodeCommand[] {
  if (!code) return [{ label: "Give it a preview code", command: "sitesolide lock" }]
  return [
    { label: "Replace the code", command: "sitesolide lock --new-code" },
    { label: "Remove the code", command: "sitesolide unlock" },
  ]
}

// --- People with access ----------------------------------------------------------------

export type SignIn = AccessPageResponse["signIn"]

/** Does this person sign in with their company account? The steward's rule, `signsInWithAccount`. */
export function signsInWithAccount(email: string, signIn: SignIn): boolean {
  return signIn.configured && maySignIn(email, signIn.allowedDomains, signIn.admins)
}

/** How long a password access lasts, the steward's four (PASSWORD_DURATIONS_S), from the shortest. */
export const PASSWORD_DURATIONS: readonly { seconds: number | null; label: string }[] = [
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
  { seconds: 30 * 24 * 3600, label: "30 days" },
  { seconds: null, label: "No expiry" },
]

export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600

/** What the field holds, read the way the steward will read it. */
export type Who =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "domain"; who: string; domain: string }
  | { kind: "person"; who: string; email: string }

/** The registry's `readWho`, with the page's words: an email, or a domain with its @. */
export function readWho(text: string): Who {
  const typed = text.trim()
  if (typed === "") return { kind: "empty" }
  if (typed.startsWith("@")) {
    const domain = cleanDomain(typed.slice(1))
    return domain === null ? { kind: "invalid", message: `${typed} isn't a domain. Write it like @company.com.` } : { kind: "domain", who: `@${domain}`, domain }
  }
  const email = cleanEmail(typed)
  if (email !== null) return { kind: "person", who: email, email }
  const domain = cleanDomain(typed)
  if (domain !== null) return { kind: "invalid", message: `For everyone at ${domain}, write @${domain}.` }
  return { kind: "invalid", message: "Enter an email, like name@company.com, or a domain, like @company.com." }
}

/** Who asks, as the page knows it: the owner, or a person and their role on the project. */
export type Viewer = AccessPageResponse["you"]

export type Addition = {
  /** `ready` can be added; `blocked` never could, by this viewer; `existing` is on the list already. */
  state: "empty" | "invalid" | "blocked" | "existing" | "ready"
  who: string | null
  kind: "person" | "domain" | null
  /** Someone new outside the company's domains: a password is drawn for them, shown once. */
  password: boolean
  /** The roles this addition may carry, from the lowest. */
  roles: AccessRole[]
  /** The line under the field. */
  hint: string
  /** Why the roles beyond `roles` are not offered, when the viewer could give them otherwise. */
  limit: string | null
}

function domainsText(signIn: SignIn): string {
  return signIn.allowedDomains.join(", ")
}

/** The line under an empty field. */
export function emptyHint(signIn: SignIn): string {
  return signIn.configured
    ? "An email, or @company.com for everyone with an account there."
    : "An email. Company sign-in isn't set up here, so they get password access."
}

/**
 * What adding this text will give, said before it is sent: the steward's
 * `judgeGrant` from the page's side. Someone inside the company's domains
 * signs in with their company account and may hold any role the viewer may
 * give; someone outside gets password access and can only open the site; a
 * domain can only open it, and only the owner gives one outside the
 * company's domains.
 */
export function planAddition(
  text: string,
  page: { entries: readonly EntryView[]; signIn: SignIn; grantable: readonly AccessRole[]; you: Viewer },
): Addition {
  const none = { who: null, kind: null, password: false, roles: [], limit: null }
  const who = readWho(text)
  if (who.kind === "empty") return { ...none, state: "empty", hint: emptyHint(page.signIn) }
  if (who.kind === "invalid") return { ...none, state: "invalid", hint: who.message }

  const existing = page.entries.find((entry) => entry.who === who.who) ?? null
  if (existing !== null) {
    return { ...none, state: "existing", who: who.who, kind: who.kind, hint: `${who.who} is already on the list, as ${roleLabel(existing.role)}. Change it below.` }
  }
  const higher = page.grantable.length > 1

  if (who.kind === "domain") {
    const base = { ...none, who: who.who, kind: "domain" as const }
    if (!page.signIn.configured) {
      return { ...base, state: "blocked", hint: "Company sign-in isn't set up here, so nobody at a domain could open the site. Add people by email: they get password access." }
    }
    // The steward's rule: with the company's domains listed, a domain is one of
    // them, whoever gives it; with none listed, any domain, under the unlock.
    if (page.signIn.allowedDomains.length > 0 && !page.signIn.allowedDomains.includes(who.domain)) {
      return {
        ...base,
        state: "blocked",
        hint: `${who.domain} isn't one of the company's domains (${domainsText(page.signIn)}): nobody there could sign in. Add people by email.`,
      }
    }
    return {
      ...base,
      state: "ready",
      roles: ["visitor"],
      hint: `Everyone with a company account at ${who.domain} can open the site.`,
      limit: higher ? "A domain can only open the site: give people roles one by one." : null,
    }
  }

  const base = { ...none, who: who.who, kind: "person" as const }
  if (signsInWithAccount(who.email, page.signIn)) {
    const top = page.grantable[page.grantable.length - 1]
    const capped = top !== undefined && top !== "admin" && page.you.kind !== "owner"
    return {
      ...base,
      state: "ready",
      roles: [...page.grantable],
      hint: `${who.email} signs in with their company account.`,
      limit: capped ? `You can give at most ${roleLabel(top)}, your own role.` : null,
    }
  }
  const why = page.signIn.configured
    ? `${domainOf(who.email)} isn't one of the company's domains (${domainsText(page.signIn)})`
    : "Company sign-in isn't set up here"
  return {
    ...base,
    state: "ready",
    password: true,
    roles: ["visitor"],
    hint: `${why}: ${who.email} gets password access, to open the site only. The password is shown once, after adding.`,
    limit: higher ? "Password access can only open the site." : null,
  }
}

/** Does this change wait for the unlock? A role above Can open, or a password drawn: the steward's rule. */
export function needsUnlock(role: AccessRole, password: boolean): boolean {
  return password || rank(role) > rank("visitor")
}

/** Does changing someone from one role to another wait for the unlock? Raising above Can open does; lowering never. */
export function raiseNeedsUnlock(from: AccessRole, to: AccessRole): boolean {
  return rank(to) > rank(from) && needsUnlock(to, false)
}

/** Who gave an entry, in the quiet words of its row. */
export function byText(by: string, you: Viewer): string {
  if (by === "owner") return you.kind === "owner" ? "you" : "the owner"
  if (by.startsWith("token:")) return "a token"
  if (you.kind === "person" && by === you.email) return "you"
  return by
}

export type Expiry = { text: string; tone: Tone }

/** Within this, a password access's expiry is worth a look. */
export const EXPIRY_SOON_MS = 24 * 3600_000

/** A password access's expiry in words: "expires in 5d", "expired 2d ago", "no expiry". */
export function passwordExpiry(password: NonNullable<EntryView["password"]>, now: number): Expiry {
  if (password.expiresAt === null) return { text: "no expiry", tone: "neutral" }
  const remaining = password.expiresAt - now
  if (password.expired || remaining <= 0) return { text: `expired ${ago(Math.max(0, -remaining))}`, tone: "neutral" }
  return { text: `expires in ${duration(remaining)}`, tone: remaining < EXPIRY_SOON_MS ? "attention" : "neutral" }
}

export type EntryRow = {
  entry: EntryView
  /** What this entry is, under its name: a domain's people, a password and its expiry. */
  what: string | null
  whatTone: Tone | null
  /** Who gave it, and when: quiet. */
  added: string
  /** The roles its menu offers, or null when it is shown as a word only. */
  roles: AccessRole[] | null
  removable: boolean
  /** The person signed in, on their own row. */
  self: boolean
}

/**
 * How an entry reads, and what the viewer may do with it: change its role
 * among those they may give and it may hold, remove it if they could have
 * given its role. Lowering and removing never wait for an unlock.
 */
export function entryRow(entry: EntryView, page: { signIn: SignIn; grantable: readonly AccessRole[]; you: Viewer }, now: number): EntryRow {
  const top = page.grantable[page.grantable.length - 1]
  const reach = top === undefined ? -1 : rank(top)
  const manageable = rank(entry.role) <= reach
  // Carried over from before the registry: who gave it was not kept.
  const added = entry.by === "migration" ? `Added ${ago(now - entry.createdAt)}` : `Added by ${byText(entry.by, page.you)}, ${ago(now - entry.createdAt)}`
  const self = page.you.kind === "person" && entry.who === page.you.email
  if (entry.kind === "domain") {
    return { entry, what: `Everyone with a company account at ${entry.who.slice(1)}`, whatTone: null, added, roles: null, removable: manageable, self }
  }
  if (entry.kind === "password" || entry.password !== null) {
    const expiry = entry.password === null ? null : passwordExpiry(entry.password, now)
    return { entry, what: expiry === null ? "Password access" : `Password access, ${expiry.text}`, whatTone: expiry?.tone ?? null, added, roles: null, removable: manageable, self }
  }
  const account = signsInWithAccount(entry.who, page.signIn)
  const roles = manageable && account && page.grantable.length > 1 ? [...page.grantable] : null
  return { entry, what: account ? null : "Can only open the site: not a company account", whatTone: null, added, roles, removable: manageable, self }
}

/** The list in reading order: the higher roles first, then people, domains, password access, then by name. */
export function sortEntries(entries: readonly EntryView[]): EntryView[] {
  const kinds = { person: 0, domain: 1, password: 2 }
  return [...entries].sort((a, b) => rank(b.role) - rank(a.role) || kinds[a.kind] - kinds[b.kind] || a.who.localeCompare(b.who, "en"))
}

/**
 * "your Google account", or "your company account" when the provider has no
 * name: the portal then hands over its own generic words, which start with "your".
 */
export function accountWords(providerName: string | null): string {
  if (providerName === null || providerName.trim() === "") return "your company account"
  return providerName.startsWith("your ") ? providerName : `your ${providerName} account`
}

/**
 * The line to send someone just given access, ready to paste: where to go
 * and with which account. No email is sent. Password access has its own,
 * with the password, shown once.
 */
export function sendLine(entry: Pick<EntryView, "who" | "kind" | "role">, page: Pick<AccessPageResponse, "slug" | "url" | "dashboardUrl" | "providerName">): string | null {
  if (entry.kind === "password") return null
  const account = accountWords(page.providerName)
  if (entry.kind === "domain") return `Open ${page.url} and sign in with ${account}.`
  if (entry.role === "visitor") return `Open ${page.url} and sign in with ${account}.`
  return `${page.slug} is at ${page.url}, and in the dashboard at ${page.dashboardUrl}. Sign in with ${account}.`
}

/** What the password's "Copy message" puts on the clipboard: the address, the password, the expiry if any. */
export function passwordMessage(url: string, password: string, expiresAt: number | null, timeZone?: string): string {
  const lines = [url, `Password: ${password}`]
  if (expiresAt !== null) lines.push(`Valid until ${dateTime(expiresAt, timeZone)}`)
  return lines.join("\n")
}

/** What a chosen duration gives, said before adding: the exact end, or none. */
export function plannedEnd(seconds: number | null, now: number, timeZone?: string): string {
  return seconds === null ? "Stays valid until removed." : `Ends ${dateTime(now + seconds * 1000, timeZone)}.`
}

/**
 * The password is never shown again. Closing its screen without having copied
 * it therefore takes two gestures: the first warns, the second closes.
 */
export function closeOutcome(copied: boolean, warned: boolean): "close" | "warn" {
  return copied || warned ? "close" : "warn"
}

/**
 * What Can open changes while the site is not restricted: nothing, the other
 * roles still counting in the dashboard. Null when it is restricted.
 */
export function inertNote(slug: string, current: GeneralAccess): string | null {
  if (current === "restricted") return null
  const how = current === "public" ? "is public" : "opens with its preview code"
  return `${slug} ${how}: Can open changes nothing until its access is restricted. The other roles still count here.`
}

/** A refusal of the steward's or the service's, in words. */
export function refusalText(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 0) return "Can't reach the dashboard. Check your connection."
  if (typeof body?.message === "string" && body.message !== "") return body.message
  if (body?.error === "origin-refused") return "Origin not allowed."
  return `Refused (${status}).`
}

/**
 * What the portal on the machine reads, when it is worth a word: one that
 * still keeps its own lists does not see changes made here.
 */
export function readingProblem(portal: AccessPageResponse["portal"]): { tone: "attention" | "error"; text: string } | null {
  switch (portal.reading) {
    case "portal":
      return { tone: "attention", text: "The portal on this server still reads its own lists, so changes here don't reach the site yet. Run sitesolide upgrade." }
    case "unreadable":
      return { tone: "error", text: "The portal can't read who has access: nobody on this list opens a restricted site until it can. Run sitesolide upgrade, then check the steward's journal." }
    default:
      return null
  }
}
