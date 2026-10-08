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
  /** Does sitesolide.json ask for Restricted: how the site opens once a preview code is removed. */
  requested: boolean
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
  const requested = site.portal.wanted
  switch (access.kind) {
    case "portal":
      return { current: "restricted", problem: null, exemptions, code: null, requested }
    case "code":
      return { current: "code", problem: null, exemptions: [], code, requested }
    case "open":
      return { current: "public", problem: null, exemptions: [], code: null, requested }
    case "mismatch":
      switch (access.key) {
        case "portal-absent":
          return {
            current: "public",
            problem: {
              title: "Restricted in sitesolide.json, public on the server",
              detail: "Anyone can open it right now. Choose one below.",
              portal: true,
            },
            exemptions,
            code: null,
            requested,
          }
        case "portal-extra":
          return {
            current: "restricted",
            problem: {
              title: "Restricted on the server, public in sitesolide.json",
              detail: "Choose one below.",
              portal: true,
            },
            exemptions,
            code: null,
            requested,
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
            requested,
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
            requested,
          }
      }
  }
}

export type ChoiceOption = GeneralChoice & {
  /** The site opens this way now. */
  current: boolean
  /** It may be chosen here, now. */
  available: boolean
  /** What its button says when it may: Make public, Restrict; in a disagreement, Keep or Apply. */
  action: string | null
  /** In a disagreement between the server and sitesolide.json, which side this choice is. */
  side: "On the server" | "In sitesolide.json" | null
}

/** What a choice's button says it will do, outside a disagreement. */
const ACTIONS: Record<"public" | "restricted", string> = { public: "Make public", restricted: "Restrict" }

/**
 * What each choice offers. Public and restricted change here, through the
 * steward, for those who may change general access; a preview code is
 * `sitesolide lock`'s, from the project's folder, said once under the
 * choices (`generalNote`), and while it is set the other two wait for it to
 * be removed. `steward` is null until the steward has said whether the site
 * may change; its reason, when it refuses, is said once too.
 */
export function generalOptions(
  state: GeneralState,
  steward: { modifiable: boolean; reason: string | null } | null,
  mayChange: boolean,
): ChoiceOption[] {
  const disagreement = state.problem?.portal === true
  return GENERAL_CHOICES.map((choice) => {
    const current = choice.access === state.current
    const side = !disagreement || choice.access === "code" ? null : current ? "On the server" : "In sitesolide.json"
    const base: ChoiceOption = { ...choice, current, available: false, action: null, side }
    if (!mayChange || choice.access === "code" || state.current === "code") return base
    // In disagreement, both sides may be chosen: either brings them together.
    if (current && !disagreement) return base
    if (steward === null || !steward.modifiable) return base
    const action = disagreement ? `${current ? "Keep" : "Apply"} ${choice.title}` : ACTIONS[choice.access as "public" | "restricted"]
    return { ...base, available: true, action }
  })
}

/** Who reads General access: the owner, an Admin of the project, or someone who only reads it. */
export type GeneralReader = "owner" | "admin" | "reader"

/**
 * The one line under the three choices about the preview code, said once
 * rather than on a row: the owner sets and removes it with the CLI, and
 * learns how the site opens once it is gone; an Admin cannot. Null when
 * there is nothing to say, for whoever only reads.
 */
export function generalNote(state: GeneralState, reader: GeneralReader): string | null {
  if (reader === "reader") return null
  if (state.current === "code") {
    return reader === "owner"
      ? `To make it public or restricted, remove the code first: sitesolide unlock, in the project's folder. It then opens as sitesolide.json says: ${state.requested ? "Restricted" : "Public"}.`
      : "Only the owner removes the code; ask them, then restrict it here."
  }
  return reader === "owner" ? "A preview code is set with sitesolide lock, in the project's folder." : "Only the owner sets a preview code."
}

/**
 * General access for someone who may not change it, in one line: how the
 * site opens, and who changes it. A platform project says how it opens
 * alone: nobody but the owner has any say on it.
 */
export function generalLine(state: GeneralState, slug: string, platform = false): string {
  const choice = GENERAL_CHOICES.find((one) => one.access === state.current)!
  const how = choice.access === "code" ? "the preview code opens it." : `${choice.sentence.charAt(0).toLowerCase()}${choice.sentence.slice(1)}`
  return platform ? `${choice.title}: ${how}` : `${choice.title}: ${how} Only an Admin of ${slug}, or the owner, changes it.`
}

export type ChangeTexts = {
  title: string
  /** Said first, in red, before making a site public: what it opens. */
  warning: string | null
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
      warning: null,
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
    warning: "Anyone with its address can open it without signing in.",
    consequence: "People with access keep their dashboard roles; Can open and password access stop mattering.",
    action: "Make public",
    actionInProgress: "Making public…",
    runningTitle: `Making ${slug} public…`,
    succeeded: `${slug} is public`,
    failure: `Couldn't make ${slug} public`,
  }
}

/** What the wait takes, said before it starts. */
export const CHANGE_DURATION = "Takes up to a minute. If anything fails, nothing changes."

/**
 * Restricting a site nobody is on the list of: who will still open it. The
 * owner always does, and the admin emails, set on the server.
 */
export function emptyListWarning(slug: string, entries: number, admins: readonly string[]): string | null {
  if (entries > 0) return null
  return `Nobody is on the list yet: after this, only the owner${admins.length > 0 ? " and the admin emails" : ""} can open ${slug}.`
}

/**
 * The gatekeeper's verdict in plain words: what the site now does, and that
 * the others still answer. Its own wording, `portal set: validated, reloaded,
 * <host> answers the portal's 401, 13 other site(s) still answer`, is shown
 * as it stands when it does not read that way.
 */
export function changeResult(target: "public" | "restricted", detail: string): string {
  const host = /: validated, reloaded, (\S+) answers /.exec(detail)?.[1]
  if (host === undefined) return detail
  const lines = [target === "restricted" ? `${host} now asks visitors to sign in.` : `${host} now opens without signing in.`]
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
  /**
   * Someone who opens the site already, without an entry of their own: a
   * domain on the list covers them, or they are an admin email. Adding them
   * as Can open changes nothing, which is said in place of the hint.
   */
  covered: string | null
}

function domainsText(signIn: SignIn): string {
  const domains = signIn.allowedDomains
  return domains.length <= 1 ? (domains[0] ?? "") : `${domains.slice(0, -1).join(", ")} or ${domains.at(-1)}`
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
 * domain can only open the site, and only one of the company's.
 */
export function planAddition(
  text: string,
  page: { entries: readonly EntryView[]; signIn: SignIn; grantable: readonly AccessRole[]; you: Viewer },
): Addition {
  const none = { who: null, kind: null, password: false, roles: [], covered: null }
  const who = readWho(text)
  if (who.kind === "empty") return { ...none, state: "empty", hint: emptyHint(page.signIn) }
  if (who.kind === "invalid") return { ...none, state: "invalid", hint: who.message }

  const existing = page.entries.find((entry) => entry.who === who.who) ?? null
  if (existing !== null) {
    return { ...none, state: "existing", who: who.who, kind: who.kind, hint: `${who.who} is already on the list, as ${roleLabel(existing.role)}.` }
  }

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
        hint: `Nobody at ${who.domain} can sign in here: only ${domainsText(page.signIn)} accounts can. Add people from ${who.domain} by email: they get password access.`,
      }
    }
    return { ...base, state: "ready", roles: ["visitor"], hint: `Everyone with a company account at ${who.domain} can open the site.` }
  }

  const base = { ...none, who: who.who, kind: "person" as const }
  if (signsInWithAccount(who.email, page.signIn)) {
    const domain = `@${domainOf(who.email)}`
    const covered = page.signIn.admins.includes(who.email)
      ? `${who.email} already opens every site, as admin: it's set on the server.`
      : page.entries.some((entry) => entry.who === domain)
        ? `Already covered by ${domain}.`
        : null
    return { ...base, state: "ready", roles: [...page.grantable], hint: `${who.email} signs in with their company account.`, covered }
  }
  const why = page.signIn.configured ? `${domainOf(who.email)} isn't one of the company's domains` : "Company sign-in isn't set up here"
  return { ...base, state: "ready", password: true, roles: ["visitor"], hint: `${why}: they get password access, to open the site only.` }
}

/** Does this change wait for the unlock? A role above Can open, or a password drawn: the steward's rule. */
export function needsUnlock(role: AccessRole, password: boolean): boolean {
  return password || rank(role) > rank("visitor")
}

/**
 * What waits for the unlock, said under the field before Add is pressed:
 * "Giving Developer needs Unlock changes first.", "Password access needs
 * Unlock changes first." The words of the button that unlocks.
 */
export function unlockLine(role: AccessRole, password: boolean): string {
  return password ? "Password access needs Unlock changes first." : `Giving ${roleLabel(role)} needs Unlock changes first.`
}

/** Does changing someone from one role to another wait for the unlock? Raising above Can open does; lowering never. */
export function raiseNeedsUnlock(from: AccessRole, to: AccessRole): boolean {
  return rank(to) > rank(from) && needsUnlock(to, false)
}

/** Is going from one role to the other a step down the ladder? */
export function lowers(from: AccessRole, to: AccessRole): boolean {
  return rank(to) < rank(from)
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
  /** What this entry is, under its name: a domain's people, a password and its expiry, why someone can't sign in. */
  what: string | null
  whatTone: Tone | null
  /** Who gave it, and when: quiet. Null for what was carried over, whose giver was not kept. */
  added: string | null
  /** The roles its menu offers, or null when it is shown as a word only. */
  roles: AccessRole[] | null
  /** The word in the role column when there is no menu: the role, or Expired. */
  word: string
  /** The word is greyed: a password access that ended, someone who can't sign in. */
  muted: boolean
  removable: boolean
  /** The person signed in, on their own row. */
  self: boolean
}

/** Why someone named on the list can't sign in, or null when they can. */
function signInProblem(email: string, signIn: SignIn): string | null {
  if (!signIn.configured) return "Can't sign in until company sign-in is set up."
  if (signsInWithAccount(email, signIn)) return null
  return `Can't sign in: ${domainOf(email)} isn't one of the company's domains.`
}

/**
 * How an entry reads, and what the viewer may do with it: change its role
 * among those they may give and it may hold, remove it if they could have
 * given its role. Lowering and removing never wait for an unlock. Someone
 * who may manage nothing reads every row as words.
 */
export function entryRow(entry: EntryView, page: { signIn: SignIn; grantable: readonly AccessRole[]; you: Viewer }, now: number): EntryRow {
  const top = page.grantable[page.grantable.length - 1]
  const reach = top === undefined ? -1 : rank(top)
  const manageable = rank(entry.role) <= reach
  const added = entry.by === "migration" ? null : `Added by ${byText(entry.by, page.you)}, ${ago(now - entry.createdAt)}`
  const self = page.you.kind === "person" && entry.who === page.you.email
  const base = { entry, whatTone: null, added, roles: null, word: roleLabel(entry.role), muted: false, removable: manageable, self }
  if (entry.kind === "domain") {
    // Nobody at a domain signs in without company sign-in: the entry waits, greyed.
    if (!page.signIn.configured) return { ...base, what: "Can't sign in until company sign-in is set up.", muted: true }
    return { ...base, what: `Everyone with a company account at ${entry.who.slice(1)}` }
  }
  if (entry.kind === "password" || entry.password !== null) {
    if (entry.password === null) return { ...base, what: "Password access" }
    const expiry = passwordExpiry(entry.password, now)
    const expired = isExpired(entry, now)
    return { ...base, what: `Password access, ${expiry.text}`, whatTone: expiry.tone, word: expired ? "Expired" : base.word, muted: expired }
  }
  const problem = signInProblem(entry.who, page.signIn)
  if (problem !== null) return { ...base, what: problem, muted: true }
  return { ...base, what: null, roles: manageable && page.grantable.length > 1 ? [...page.grantable] : null }
}

/** A password access whose end has passed: it opens nothing, and its row says so. */
export function isExpired(entry: Pick<EntryView, "password">, now: number): boolean {
  return entry.password !== null && (entry.password.expired || (entry.password.expiresAt !== null && entry.password.expiresAt <= now))
}

/** The list in reading order: the higher roles first, then people, domains, password access, then by name; what expired last. */
export function sortEntries(entries: readonly EntryView[], now: number): EntryView[] {
  const kinds = { person: 0, domain: 1, password: 2 }
  const ended = (entry: EntryView) => (isExpired(entry, now) ? 1 : 0)
  return [...entries].sort((a, b) => ended(a) - ended(b) || rank(b.role) - rank(a.role) || kinds[a.kind] - kinds[b.kind] || a.who.localeCompare(b.who, "en"))
}

/**
 * Who opens the site without being on its list, said once under it: the
 * owner, and the admin emails set on the server.
 */
export function alsoOpens(admins: readonly string[]): string {
  if (admins.length === 0) return "The owner also opens it."
  return `Also open it: the owner, and ${admins.join(", ")} (${admins.length > 1 ? "admin emails" : "an admin email"} set on the server; sites see them as admin).`
}

/** For someone who may not add people: whom to ask, by name. */
export function askAnAdmin(entries: readonly EntryView[]): string {
  const admins = entries.filter((entry) => entry.kind === "person" && entry.role === "admin").map((entry) => entry.who)
  return admins.length === 0 ? "To add someone, ask the owner." : `To add someone, ask an Admin: ${admins.join(", ")}.`
}

/** What someone has now, in one sentence: "dana@example.com can now open cms.", "dana@example.com is now Viewer on cms." */
export function grantSentence(who: string, role: AccessRole, slug: string): string {
  return role === "visitor" ? `${who} can now open ${slug}.` : `${who} is now ${roleLabel(role)} on ${slug}.`
}

/**
 * Lowering someone to Can open, or removing them, when that leaves them no
 * role above Can open and no right to create projects: they no longer sign
 * in to the dashboard, and their tokens are revoked. Said before it is done:
 * "chloe@example.com will no longer sign in to the dashboard. Also revokes 2
 * tokens: alice-ci (made by them), Alice's laptop (made by you)." Null when
 * the change takes nobody out; the steward said whom it would, in `leaving`.
 */
export function leavingWarning(who: string, role: AccessRole | null, page: Pick<AccessPageResponse, "leaving" | "you">): string | null {
  if (role !== null && role !== "visitor") return null
  const leaving = page.leaving ?? {}
  if (!Object.hasOwn(leaving, who)) return null
  const tokens = leaving[who]!
  const self = page.you.kind === "person" && page.you.email === who
  const first = self ? "You will no longer sign in to the dashboard." : `${who} will no longer sign in to the dashboard.`
  if (tokens.length === 0) return first
  const maker = (madeBy: "them" | "owner") => (madeBy === "them" ? (self ? "you" : "them") : page.you.kind === "owner" ? "you" : "the owner")
  const named = tokens.map((token) => `${token.label} (made by ${maker(token.madeBy)})`).join(", ")
  return `${first} Also revokes ${tokens.length === 1 ? "1 token" : `${tokens.length} tokens`}: ${named}.`
}

/** An Admin lowering or removing themselves: what they give up, said before it is done. */
export function selfChangeWarning(slug: string): string {
  return `You'll no longer manage ${slug}. Only another Admin or the owner can give it back.`
}

/** The people with access in a few words, for the Overview: "6 people and 1 domain have access". */
export function accessSummary(entries: readonly EntryView[]): string {
  const domains = entries.filter((entry) => entry.kind === "domain").length
  const people = entries.length - domains
  if (people + domains === 0) return "Nobody is on the list yet"
  const parts = [people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : null, domains > 0 ? `${domains} ${domains === 1 ? "domain" : "domains"}` : null].filter(
    (part): part is string => part !== null,
  )
  return `${parts.join(" and ")} ${people + domains === 1 ? "has" : "have"} access`
}

/**
 * The platform's own projects, the steward's `reservedReason`
 * (src/control/policy.ts): nobody is given a role on them. The page cannot
 * import that list; tests/access.test.ts reads it back from the policy.
 */
export const PLATFORM_SLUGS: readonly string[] = ["dashboard", "portal", "api", "analytics", "landing", "www"]

/** Is this project part of the platform: one of its own, or the landing, named after the zone. */
export function isPlatform(slug: string, zone: string | null): boolean {
  return PLATFORM_SLUGS.includes(slug) || (zone !== null && zone !== "" && slug === zone)
}

/** What a platform project's Access says, in place of its people. */
export function platformText(slug: string): string {
  return `${slug} is part of the platform. Only the owner opens it when restricted; no one can be given a role on it.`
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
  const line = `${page.slug} is at ${page.url}, and in the dashboard at ${page.dashboardUrl}. Sign in with ${account}.`
  // Developer and Admin deploy: how, from their workstation.
  if (entry.role === "viewer") return line
  return `${line} To deploy, create a token on the Tokens page, then run sitesolide login --url ${page.dashboardUrl}.`
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
export function inertNote(slug: string, current: GeneralAccess, manages: boolean): string | null {
  if (current === "restricted") return null
  const how = current === "public" ? "is public, so anyone can open it" : "opens with its preview code"
  return `${slug} ${how}. Viewer, Developer and Admin still apply; Can open matters once ${manages ? "you restrict it" : "it's restricted"}.`
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
 * still keeps its own lists does not see changes made here.
 */
export function readingProblem(portal: AccessPageResponse["portal"]): { tone: "attention" | "error"; text: string } | null {
  switch (portal.reading) {
    case "portal":
      return { tone: "attention", text: "The portal on this server still reads its own lists, so changes here don't reach the site yet. Run sitesolide upgrade." }
    case "unreadable":
      return { tone: "error", text: "The portal can't read who has access: nobody on this list opens a restricted site until it can. Run sitesolide upgrade, then sitesolide status." }
    default:
      return null
  }
}
