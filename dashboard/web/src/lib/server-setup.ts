/**
 * The server's own settings as two places show them, one row each: the
 * Server page, every setting in a stable order, done or not, and the Sites
 * page's setup guide, only what is still missing. Pure: what a row says, what
 * it offers, which rows the guide shows, each guide's steps and what they
 * accept, and the viewer's own choices kept in this browser.
 *
 * Built on the catalogue in lib/machine-settings.ts, which names each
 * setting's file, variables and reader; nothing here names a file or a
 * variable on screen. A row is made of names, dates and the monitor's word
 * on its channels, never of a value: a value is typed into a guide and sent,
 * or revealed by the owner for thirty seconds through the steward.
 *
 * Like the rest of the page it judges nothing the steward judges. The checks
 * below help before sending (an address the monitor would refuse, a
 * passphrase the backup run would refuse); the steward's refusal is shown as
 * it stands.
 */
import {
  GROUP_LABELS,
  WEBHOOK_FORMATS,
  alertAddressProblem,
  detectedWebhookFormat,
  heartbeatPageHint,
  settingById,
  settingsOf,
  webhookAddressHint,
  type MachineSetting,
  type Presence,
  type SettingGroup,
  type SettingId,
  type SettingState,
  type WebhookFormat,
} from "./machine-settings"
import { plural } from "./format"
import type { Tone } from "./tones"
import type { Alerting, LogEntry } from "./types"

// --- The rows ------------------------------------------------------------------

/** A row: every setting of the catalogue but the message format, which the webhook's row and guide carry. */
export type RowId = Exclude<SettingId, "format">

/** The rows a guide sets up, in the order the Sites panel lists them. */
export type GuideId = "heartbeat" | "webhook" | "offsite" | "company-signin"

export const GUIDE_ROWS: readonly GuideId[] = ["heartbeat", "webhook", "offsite", "company-signin"]

export function isGuide(id: RowId): id is GuideId {
  return (GUIDE_ROWS as readonly string[]).includes(id)
}

export type RowSpec = {
  id: RowId
  /** The row's name, the catalogue's label: "Heartbeat". */
  name: string
  /** The same in a sentence: "Remove the heartbeat?", "Unlock to reveal the heartbeat". */
  noun: string
  /** What it does, on the Server page. */
  serverLine: string
  /** Why it is missing, on the Sites panel; null for a row the panel never lists, the passwords. */
  sitesLine: string | null
  /** May be skipped by the viewer: the optional settings alone. */
  skippable: boolean
}

const SPECS: Readonly<Record<RowId, Omit<RowSpec, "id" | "name">>> = {
  heartbeat: {
    noun: "heartbeat",
    serverLine: "Pings an outside service so you hear if the server dies.",
    sitesLine: "Nothing outside the server notices if it goes down.",
    skippable: false,
  },
  webhook: {
    noun: "alert webhook",
    serverLine: "Posts in your chat when a site goes down or recovers.",
    sitesLine: "Get a message when a site goes down.",
    skippable: false,
  },
  "dashboard-password": {
    noun: "dashboard password",
    serverLine: "Signs you in to this dashboard and unlocks changes.",
    sitesLine: null,
    skippable: false,
  },
  "portal-password": {
    noun: "portal password",
    // The owner's password at the portal (portal/README.md): it opens every restricted site, as admin.
    serverLine: "Signs you in to every restricted site, at its sign-in page.",
    sitesLine: null,
    skippable: false,
  },
  "company-signin": {
    noun: "company sign-in",
    serverLine: "Lets people sign in with their company account.",
    sitesLine: "Optional. People sign in with their company account.",
    skippable: true,
  },
  offsite: {
    noun: "offsite copy",
    serverLine: "Copies the encrypted backups outside the server, every hour.",
    sitesLine: "Snapshots stay on this server only.",
    skippable: true,
  },
}

export function rowSpec(id: RowId): RowSpec {
  return { id, name: settingById(id).label, ...SPECS[id] }
}

/** The Server page's panels, always in this order, each with when a change applies in plain words. */
export type ServerGroup = { id: SettingGroup; title: string; note: string; rows: readonly RowId[] }

const GROUP_NOTES: Readonly<Record<SettingGroup, string>> = {
  monitoring: "Changes apply within a minute. Nothing restarts.",
  "sign-in": "The portal applies changes when it restarts.",
  offsite: "The next hourly backup uses the change.",
}

export const SERVER_GROUPS: readonly ServerGroup[] = (["monitoring", "sign-in", "offsite"] as const).map((id) => ({
  id,
  title: GROUP_LABELS[id],
  note: GROUP_NOTES[id],
  rows: settingsOf(id)
    .map((setting) => setting.id)
    .filter((one): one is RowId => one !== "format"),
}))

// --- When a setting changed ----------------------------------------------------

/** "just now", "12 seconds ago", "1 minute ago", "12 days ago": a row's age, in words. */
export function changedWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 20) return "just now"
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${plural(minutes, "minute")} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, "hour")} ago`
  return `${plural(Math.floor(hours / 24), "day")} ago`
}

/** The variables a row stands for: the webhook's carry its message format. */
export function rowVariables(id: RowId): string[] {
  const own = settingById(id).variables.map((variable) => variable.name)
  return id === "webhook" ? [...own, ...settingById("format").variables.map((variable) => variable.name)] : own
}

const CHANGES = new Set(["set", "remove", "password", "restore"])

/**
 * When each row last changed. The steward dates a file, not a variable, so
 * its log says when a setting sharing its file with another changed: the
 * latest change of one of its variables, or a restore of the whole file.
 * Without such a line among the ones read, the file's date stands only for
 * a setting alone in its file; null otherwise, and the row says "Set".
 */
export function changeDates(states: Readonly<Record<SettingId, SettingState>>, log: readonly LogEntry[] | null): Record<RowId, number | null> {
  const dates = {} as Record<RowId, number | null>
  for (const group of SERVER_GROUPS) {
    for (const id of group.rows) {
      const setting = settingById(id)
      const names = rowVariables(id)
      let latest: number | null = null
      for (const entry of log ?? []) {
        if (entry.result !== "ok" || !CHANGES.has(entry.operation)) continue
        if (entry.slug !== setting.slug || entry.file !== setting.file) continue
        if (entry.variable !== null && !names.includes(entry.variable)) continue
        if (latest === null || entry.a > latest) latest = entry.a
      }
      dates[id] = latest ?? (aloneInFile(setting) ? states[id].changedAt : null)
    }
  }
  return dates
}

function aloneInFile(setting: MachineSetting): boolean {
  return SERVER_GROUPS.flatMap((group) => group.rows).every((id) => id === setting.id || settingById(id).file !== setting.file || settingById(id).slug !== setting.slug)
}

// --- The heartbeat's first ping ----------------------------------------------------

/**
 * What the page waits for after saving a heartbeat: the monitor's first pass
 * that read the new address. `savedAt` and `deliveredAt` are on the server's
 * clock; `seen`, the guide closed on the result.
 */
export type Proof = { savedAt: number; deliveredAt: number | null; seen: boolean }

/**
 * - `waiting`: the monitor has not passed since the save;
 * - `delivered`, `failed`: its pass since then pinged the address, or failed to;
 * - `refused`: it passed and took no address, which is how it refuses one;
 * - `unknown`: the monitor says nothing now (`alerting` null), and the page cannot tell.
 */
export type ProofPhase = "waiting" | "delivered" | "failed" | "refused" | "unknown"

export function proofPhase(proof: Pick<Proof, "savedAt">, alerting: Alerting | null | undefined): ProofPhase {
  if (alerting === null || alerting === undefined) return "unknown"
  if (alerting.at <= proof.savedAt) return "waiting"
  if (alerting.heartbeat === "ok") return "delivered"
  if (alerting.heartbeat === "failed") return "failed"
  return "refused"
}

/** The monitor passes every minute. */
export const MONITOR_PASS_MS = 60_000

/** How long the Server page says Delivered after the first ping, and the Sites panel keeps the row once its guide is closed. */
export const DELIVERED_SERVER_MS = 60_000
export const DELIVERED_SITES_MS = 5_000

/** Seconds until the monitor's next pass, from its last one; 0 once it is due. */
export function nextPassSeconds(alerting: Alerting | null | undefined, serverNow: number): number {
  if (alerting === null || alerting === undefined) return 0
  return Math.max(0, Math.ceil((alerting.at + MONITOR_PASS_MS - serverNow) / 1000))
}

/** Seconds since the monitor's last pass, for the wait's track. */
export function lastPassSeconds(alerting: Alerting | null | undefined, serverNow: number): number {
  if (alerting === null || alerting === undefined) return 0
  return Math.min(MONITOR_PASS_MS / 1000, Math.max(0, Math.floor((serverNow - alerting.at) / 1000)))
}

/** "first ping in 34s", or "first ping any moment now" once the pass is due. */
function firstPingWords(alerting: Alerting | null | undefined, serverNow: number): string {
  const seconds = nextPassSeconds(alerting, serverNow)
  return seconds > 0 ? `first ping in ${seconds}s` : "first ping any moment now"
}

/** "Waiting for the monitor's next pass… 34s", for the Sites row and the guide. */
export function waitingWords(alerting: Alerting | null | undefined, serverNow: number): string {
  const seconds = nextPassSeconds(alerting, serverNow)
  return seconds > 0 ? `Waiting for the monitor's next pass… ${seconds}s` : "Waiting for the monitor's next pass, any moment now."
}

// --- What a row says -----------------------------------------------------------

/** Where a guide opens: its first step, the step that takes the value (Change), or the heartbeat's wait. */
export type GuideStart = "start" | "value" | "wait"

export type RowAction =
  | { kind: "guide"; label: string; start: GuideStart; primary: boolean }
  /** The passwords keep their own dialog. */
  | { kind: "password" }
  /** What the page cannot change: the platform site's Secrets, where the reason is. */
  | { kind: "secrets"; label: string; slug: "dashboard" | "portal" }

/** The "..." menu's secondary actions, in this order: Reveal, Restart, Skip or Unskip, then Remove under a separator. */
export type MenuEntry = "reveal" | "restart" | "skip" | "unskip" | "remove"

export type RowView = {
  id: RowId
  /** The sentence beside the name. */
  line: string
  /** The state's word on the right; empty while nothing is known. */
  word: string
  tone: Tone
  /** Delivered carries a check before its word. */
  check: boolean
  /** A second, muted line under the word: "changed 4 minutes ago", "3 undelivered". */
  extra: string | null
  /** The word's tooltip. */
  tip: string | null
  /** An error: the severity icon in the gutter, in place of the row's icon. */
  error: boolean
  action: RowAction | null
  menu: MenuEntry[]
}

/** What the backups say of the offsite copy, from their last run: where it goes, or why it could not. */
export type OffsiteReading = { target: string | null; error: string | null }

export type RowInputs = {
  states: Readonly<Record<SettingId, SettingState>>
  alerting: Alerting | null | undefined
  /** The server's clock. */
  serverNow: number
  changed: Readonly<Record<RowId, number | null>>
  /** The heartbeat's first ping, while the page waits for it or has just seen it. */
  proof: Proof | null
  /** null until the backups have been read, or when they could not be. */
  offsite: OffsiteReading | null
  skipped: ReadonlySet<RowId>
}

/** "Set, changed 12 days ago", or "Set" when the date is not known. */
function setWord(changedAt: number | null, serverNow: number): string {
  return changedAt === null ? "Set" : `Set, changed ${changedWords(serverNow - changedAt)}`
}

function neededWords(state: SettingState, id: RowId): string {
  const required = settingById(id).variables.filter((variable) => variable.required).length
  return `${required - state.missing.length} of ${required} needed settings are set`
}

const guide = (label: string, start: GuideStart, primary = false): RowAction => ({ kind: "guide", label, start, primary })

/** The heartbeat in trouble: the monitor's word, or what the page saw of the first ping since a save. */
function heartbeatTrouble(state: SettingState, phase: ProofPhase | null): "failed" | "refused" | null {
  if (phase === "refused") return "refused"
  if (phase === "failed" || (phase !== "waiting" && phase !== "delivered" && state.channel === "failed")) return "failed"
  return null
}

function deliveredShown(proof: Proof | null, phase: ProofPhase | null, serverNow: number, within: number): boolean {
  if (proof === null || phase !== "delivered") return false
  return proof.deliveredAt === null || serverNow - proof.deliveredAt < within
}

const RESTART_TIPS: Readonly<Partial<Record<RowId, string>>> = {
  "dashboard-password": "Sign-in uses the new password after the dashboard restarts.",
  "portal-password": "The portal uses the new password when it restarts.",
  "company-signin": "The portal uses the new settings when it restarts.",
}

/** A row of the Server page: every setting, done or not, its state, its one action and its menu. */
export function serverRow(id: RowId, inputs: RowInputs): RowView {
  const { states, alerting, serverNow, changed, proof, offsite, skipped } = inputs
  const state = states[id]
  const spec = rowSpec(id)
  const setting = settingById(id)
  const row: RowView = { id, line: spec.serverLine, word: "", tone: "neutral", check: false, extra: null, tip: null, error: false, action: null, menu: [] }
  const password = id === "dashboard-password" || id === "portal-password"
  const restart = state.restartPending ? (["restart"] as MenuEntry[]) : []

  if (state.presence === "unknown") return row
  if (state.presence === "unmanaged") {
    return { ...row, word: "Unmanaged", tone: "attention", extra: "can't be changed from here", action: { kind: "secrets", label: "See why", slug: setting.slug } }
  }
  if (password && state.presence === "no-file") {
    return { ...row, word: "Missing", tone: "error", error: true, action: { kind: "secrets", label: "See why", slug: setting.slug } }
  }
  if (password && state.presence === "not-set") return { ...row, word: "Not set", tone: "attention", action: { kind: "password" } }

  switch (state.presence) {
    // A guide's file the owner has not made yet reads as not set: the guide's first step says how to make it.
    case "no-file":
    case "not-set":
      return {
        ...row,
        word: id === "offsite" ? "Off" : "Not set",
        tone: setting.expected ? "attention" : "neutral",
        extra: skipped.has(id) ? "skipped" : null,
        action: guide("Set up", "start"),
        menu: spec.skippable ? [skipped.has(id) ? "unskip" : "skip"] : [],
      }
    case "incomplete":
      return {
        ...row,
        word: "Incomplete",
        tone: "attention",
        extra: neededWords(state, id),
        action: guide("Set up", "value"),
        menu: ["reveal", ...restart, "remove"],
      }
    case "set":
      break
  }

  const when = changed[id]
  if (password) {
    if (state.restartPending) {
      return { ...row, word: "Restart pending", tone: "attention", extra: when === null ? null : `changed ${changedWords(serverNow - when)}`, tip: RESTART_TIPS[id] ?? null, action: { kind: "password" }, menu: restart }
    }
    return { ...row, word: setWord(when, serverNow), action: { kind: "password" } }
  }

  const menu: MenuEntry[] = ["reveal", ...restart, "remove"]
  const change = guide("Change", "value")
  switch (id) {
    case "heartbeat": {
      const phase = proof === null ? null : proofPhase(proof, alerting)
      if (phase === "waiting") {
        return { ...row, word: setWord(proof!.savedAt, serverNow), extra: firstPingWords(alerting, serverNow), action: guide("See progress", "wait"), menu }
      }
      const trouble = heartbeatTrouble(state, phase)
      if (trouble !== null) {
        return {
          ...row,
          word: "Failed",
          tone: "error",
          error: true,
          extra: trouble === "refused" ? "the monitor didn't take the address" : "last ping did not go through",
          tip: trouble === "refused" ? "The monitor didn't take this address. Check it." : "The monitor could not reach the ping URL. Check it.",
          action: guide("Change the URL", "value", true),
          menu,
        }
      }
      if (deliveredShown(proof, phase, serverNow, DELIVERED_SERVER_MS)) return { ...row, word: "Delivered", tone: "ok", check: true, action: change, menu }
      if (state.channel === "waiting") return { ...row, word: setWord(when, serverNow), extra: "not pinged yet", action: change, menu }
      return { ...row, word: setWord(when, serverNow), action: change, menu }
    }
    case "webhook": {
      if (state.channel === "failed") {
        const waiting = state.undelivered
        return {
          ...row,
          word: "Failed",
          tone: "error",
          error: true,
          extra: waiting > 0 ? `${waiting} undelivered` : "last message did not go through",
          tip:
            waiting > 0
              ? `${plural(waiting, "message")} didn't get through and wait for the next pass. Check the address.`
              : "The last message didn't get through. Check the address.",
          action: guide("Change", "value", true),
          menu,
        }
      }
      return { ...row, word: setWord(when, serverNow), action: change, menu }
    }
    case "offsite": {
      if (offsite !== null && offsite.error !== null) {
        return { ...row, word: "Misconfigured", tone: "attention", extra: "the last backup run couldn't use it", tip: "Check these settings. The site's Backups section says what went wrong.", action: change, menu }
      }
      if (offsite !== null && offsite.target !== null) return { ...row, word: "On", tone: "ok", extra: offsite.target, action: change, menu }
      return { ...row, word: setWord(when, serverNow), action: change, menu }
    }
    case "company-signin": {
      if (state.restartPending) {
        return { ...row, word: "Restart pending", tone: "attention", extra: when === null ? null : `changed ${changedWords(serverNow - when)}`, tip: RESTART_TIPS[id] ?? null, action: change, menu }
      }
      return { ...row, word: setWord(when, serverNow), action: change, menu }
    }
  }
}

// --- The Sites panel -------------------------------------------------------------

export type SitesInputs = RowInputs & {
  /** The viewer hid the guide. */
  hidden: boolean
  /** The guide open now, whose row stays while it is. */
  guideOpen: GuideId | null
}

/** Not set at all, or not all of it: what the Sites panel is for. */
function missing(state: SettingState): boolean {
  return state.presence === "no-file" || state.presence === "not-set" || state.presence === "incomplete"
}

/** The heartbeat's row stays on Sites while its first ping is awaited, failed, or has just come. */
function proofKeepsRow(inputs: SitesInputs, phase: ProofPhase | null): boolean {
  const { proof, guideOpen, serverNow } = inputs
  if (proof === null || phase === null) return false
  if (phase === "waiting" || phase === "failed" || phase === "refused") return true
  if (phase === "delivered") return !proof.seen && (guideOpen === "heartbeat" || deliveredShown(proof, phase, serverNow, DELIVERED_SITES_MS))
  return guideOpen === "heartbeat"
}

/**
 * The rows of the Sites panel, in the guide's order: what is missing and
 * not skipped, the heartbeat in trouble, and the row whose guide is open, so
 * that it does not vanish from under it. Nothing while the guide is hidden
 * or the steward's listing is not known.
 */
export function sitesRowIds(inputs: SitesInputs): GuideId[] {
  if (inputs.hidden) return []
  return GUIDE_ROWS.filter((id) => {
    const state = inputs.states[id]
    if (state.presence === "unknown" || state.presence === "unmanaged") return false
    if (inputs.guideOpen === id) return true
    if (id === "heartbeat") {
      const phase = inputs.proof === null ? null : proofPhase(inputs.proof, inputs.alerting)
      if (proofKeepsRow(inputs, phase) || heartbeatTrouble(state, phase) !== null) return true
    }
    return missing(state) && !inputs.skipped.has(id)
  })
}

/** What each guide's row says on Sites once it is set and its guide is still open. */
const SAVED_LINES: Readonly<Record<GuideId, string>> = {
  heartbeat: "Within two minutes the check turns green on healthchecks.io.",
  webhook: "The monitor sends a message the next time a site goes down or recovers.",
  offsite: "The next hourly backup copies the snapshots offsite.",
  "company-signin": "The portal reads these when it starts: restart it to apply.",
}

/**
 * A row of the Sites panel. `primary`: this row's button is the panel's one
 * primary, which `sitesRows` gives the first row left to do.
 */
export function sitesRow(id: GuideId, inputs: SitesInputs, primary = false): RowView & { todo: boolean } {
  const { states, alerting, serverNow, proof } = inputs
  const state = states[id]
  const spec = rowSpec(id)
  const row: RowView = { id, line: spec.sitesLine ?? spec.serverLine, word: "", tone: "neutral", check: false, extra: null, tip: null, error: false, action: null, menu: [] }

  if (id === "heartbeat" && state.presence === "set") {
    const phase = proof === null ? null : proofPhase(proof, alerting)
    if (phase === "waiting") {
      return { ...row, todo: false, word: setWord(proof!.savedAt, serverNow), line: waitingWords(alerting, serverNow), action: guide("See progress", "wait") }
    }
    if (heartbeatTrouble(state, phase) !== null) {
      return { ...row, todo: true, word: "Failed", tone: "error", error: true, line: "The monitor couldn't reach it. Check the URL.", action: guide("Change the URL", "value", primary) }
    }
    if (phase === "delivered") return { ...row, todo: false, word: "Delivered", tone: "ok", check: true, line: "healthchecks.io shows the check as up." }
  }
  if (state.presence === "set") return { ...row, todo: false, word: setWord(inputs.changed[id] ?? serverNow, serverNow), line: SAVED_LINES[id] }
  return {
    ...row,
    todo: true,
    line: state.presence === "incomplete" ? `Incomplete: ${neededWords(state, id)}.` : row.line,
    action: guide("Set up", "start", primary),
    menu: spec.skippable ? ["skip"] : [],
  }
}

/** The Sites panel's rows, the first one left to do carrying the panel's primary button. */
export function sitesRows(inputs: SitesInputs): RowView[] {
  const ids = sitesRowIds(inputs)
  const first = ids.find((id) => sitesRow(id, inputs).todo) ?? null
  return ids.map((id) => {
    const { todo: _, ...view } = sitesRow(id, inputs, id === first)
    return view
  })
}

// --- The viewer's own choices --------------------------------------------------------

/**
 * Whether the guide is hidden on Sites, and which optional settings the
 * viewer skipped: theirs alone, kept in this browser under one key, names
 * only, never a value and never on the server. Lost with the browser's
 * storage, which brings the guide back, and nothing worse.
 */
export const SETUP_KEY = "setup-guide"

export type SetupPrefs = { hidden: boolean; skipped: readonly GuideId[] }

export const NO_PREFS: SetupPrefs = { hidden: false, skipped: [] }

const SKIPPABLE: readonly GuideId[] = GUIDE_ROWS.filter((id) => SPECS[id].skippable)

/** The stored choices, or none when storage refuses or holds anything else. */
export function readSetupPrefs(storage: () => Pick<Storage, "getItem">): SetupPrefs {
  try {
    const text = storage().getItem(SETUP_KEY)
    if (text === null) return NO_PREFS
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return NO_PREFS
    const { hidden, skipped } = parsed as { hidden?: unknown; skipped?: unknown }
    const names = Array.isArray(skipped) ? skipped : []
    return { hidden: hidden === true, skipped: SKIPPABLE.filter((id) => names.includes(id)) }
  } catch {
    return NO_PREFS
  }
}

/** Returns false when storage refuses: the choice then holds for this page only. */
export function storeSetupPrefs(storage: () => Pick<Storage, "setItem" | "removeItem">, prefs: SetupPrefs): boolean {
  const skipped = SKIPPABLE.filter((id) => prefs.skipped.includes(id))
  try {
    if (!prefs.hidden && skipped.length === 0) storage().removeItem(SETUP_KEY)
    else storage().setItem(SETUP_KEY, JSON.stringify({ hidden: prefs.hidden, skipped }))
    return true
  } catch {
    return false
  }
}

export function withSkipped(prefs: SetupPrefs, id: GuideId, skip: boolean): SetupPrefs {
  const others = prefs.skipped.filter((one) => one !== id)
  return { ...prefs, skipped: skip && SKIPPABLE.includes(id) ? [...others, id] : others }
}

// --- The guides --------------------------------------------------------------------

export type StepId =
  | "create-check"
  | "paste-ping"
  | "wait-ping"
  | "choose-service"
  | "paste-webhook"
  | "webhook-saved"
  | "create-bucket"
  | "bucket-details"
  | "passphrase"
  | "offsite-saved"
  | "register-app"
  | "signin-details"
  | "signin-saved"

export const GUIDE_STEPS: Readonly<Record<GuideId, readonly StepId[]>> = {
  heartbeat: ["create-check", "paste-ping", "wait-ping"],
  webhook: ["choose-service", "paste-webhook", "webhook-saved"],
  offsite: ["create-bucket", "bucket-details", "passphrase", "offsite-saved"],
  "company-signin": ["register-app", "signin-details", "signin-saved"],
}

/** The step that takes the value, where Change opens. */
export const VALUE_STEP: Readonly<Record<GuideId, StepId>> = {
  heartbeat: "paste-ping",
  webhook: "paste-webhook",
  offsite: "bucket-details",
  "company-signin": "signin-details",
}

export function openingStep(id: GuideId, start: GuideStart): StepId {
  const steps = GUIDE_STEPS[id]
  if (start === "value") return VALUE_STEP[id]
  if (start === "wait") return steps[steps.length - 1]!
  return steps[0]!
}

/** "Step 2 of 3", and where the bars stand. */
export function stepPosition(id: GuideId, step: StepId): { index: number; total: number; label: string } {
  const steps = GUIDE_STEPS[id]
  const index = steps.indexOf(step) + 1
  return { index, total: steps.length, label: `Step ${index} of ${steps.length}` }
}

/** The step before, for Back; null on the first. */
export function previousStep(id: GuideId, step: StepId): StepId | null {
  const steps = GUIDE_STEPS[id]
  const index = steps.indexOf(step)
  return index > 0 ? steps[index - 1]! : null
}

export function nextStep(id: GuideId, step: StepId): StepId | null {
  const steps = GUIDE_STEPS[id]
  const index = steps.indexOf(step)
  return index >= 0 && index < steps.length - 1 ? steps[index + 1]! : null
}

/**
 * The flat file a guide needs that is not on the server yet, or null. The
 * monitor's and the backups' are made by hand, once (monitor/README.md): the
 * dashboard never creates a file that belongs to root, and the guide's first
 * step says how.
 */
export function missingFile(id: GuideId, presence: Presence): string | null {
  if (id === "company-signin" || presence !== "no-file") return null
  return settingById(id).file
}

/** Where the platform's flat files live: a path of every install, which names no machine. */
export const VAULT = "/etc/sitesolide"

/**
 * The command that makes an empty file the steward then manages: shown cut
 * before the file's name, the copy holding the whole line.
 */
export function fileCommand(file: string): { shown: string; whole: string } {
  const start = "sudo install -m 600 -o root -g root /dev/null"
  return { shown: `${start} …`, whole: `${start} ${VAULT}/${file}` }
}

/** A hint under a field: `attention` for what would go wrong, `plain` for information. */
export type Hint = { text: string; tone: "attention" | "plain" }

/** What a field says, and whether its step may go on. */
export type FieldCheck = { hints: Hint[]; ready: boolean }

/** The ping URL: the monitor's own rule, then a check's page pasted in its place. */
export function pingCheck(raw: string): FieldCheck {
  if (raw.trim() === "") return { hints: [], ready: false }
  const problem = alertAddressProblem(raw)
  if (problem !== null) return { hints: [{ text: problem, tone: "attention" }], ready: false }
  const page = heartbeatPageHint(raw)
  return { hints: page === null ? [] : [{ text: page, tone: "attention" }], ready: true }
}

/** Where the monitor's messages go, each with its outside steps. */
export type WebhookService = "slack" | "discord" | "googlechat" | "ntfy" | "other"

export const WEBHOOK_SERVICES: readonly { id: WebhookService; name: string; steps: string; placeholder: string }[] = [
  {
    id: "slack",
    name: "Slack",
    steps: "In Slack: Apps, Incoming Webhooks, Add to a channel, copy the Webhook URL.",
    placeholder: "https://hooks.slack.com/services/T000/B000/xxxxxxxx",
  },
  {
    id: "discord",
    name: "Discord",
    steps: "In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.",
    placeholder: "https://discord.com/api/webhooks/000000000000000000/xxxxxxxx",
  },
  {
    id: "googlechat",
    name: "Google Chat",
    steps: "In Google Chat: open the space menu, Apps and integrations, Webhooks, add one, copy its URL.",
    placeholder: "https://chat.googleapis.com/v1/spaces/xxxxxxxx/messages?key=xxxx&token=xxxx",
  },
  {
    id: "ntfy",
    name: "ntfy",
    steps: "At ntfy.sh, pick a topic name nobody would guess, subscribe to it in the ntfy app, and use https://ntfy.sh/ followed by that topic.",
    placeholder: "https://ntfy.sh/your-topic",
  },
  {
    id: "other",
    name: "Other",
    steps: "Any service that takes an https POST. The message goes as JSON or as plain text.",
    placeholder: "https://hooks.example.com/alerts/xxxxxxxx",
  },
]

export function serviceName(id: WebhookService): string {
  return WEBHOOK_SERVICES.find((service) => service.id === id)?.name ?? "Other"
}

export function formatLabel(format: WebhookFormat): string {
  return WEBHOOK_FORMATS.find((one) => one.value === format)?.label ?? "JSON"
}

/** A known service's own format; ntfy's is plain text. */
function serviceFormat(service: WebhookService): WebhookFormat | null {
  if (service === "slack" || service === "discord" || service === "googlechat") return service
  if (service === "ntfy") return "text"
  return null
}

/**
 * The webhook address: the monitor's rule, then the format read from it and
 * what is off about it for the service chosen. `service` is null on a Change,
 * the guide not knowing which service the address saved was for.
 */
export function webhookCheck(raw: string, service: WebhookService | null): FieldCheck {
  if (raw.trim() === "") return { hints: [], ready: false }
  const problem = alertAddressProblem(raw)
  if (problem !== null) return { hints: [{ text: problem, tone: "attention" }], ready: false }
  const detected = detectedWebhookFormat(raw)
  const hints: Hint[] = []
  const own = service === null ? null : serviceFormat(service)
  if (own === null) {
    if (service === null) hints.push({ text: `Format: ${formatLabel(detected)}, read from the address.`, tone: "plain" })
  } else if (own === detected) {
    hints.push({ text: `Format: ${formatLabel(detected)}, read from the address.`, tone: "plain" })
  } else if (service === "ntfy") {
    hints.push({ text: "This isn't ntfy.sh, so the format will be set to Plain text.", tone: "attention" })
  } else {
    hints.push({ text: `This doesn't look like a ${serviceName(service!)} address. Check it before saving.`, tone: "attention" })
  }
  const topic = webhookAddressHint(raw)
  if (topic !== null) hints.push({ text: topic, tone: "attention" })
  return { hints, ready: true }
}

/**
 * The format chosen in the guide: read from the address (`auto`), one of the
 * monitor's, or on a Change the one saved before (`keep`), which the page
 * does not know without reading it.
 */
export type FormatChoice = WebhookFormat | "auto" | "keep"

/**
 * The format the monitor should speak: a known service's own, Other's
 * choice (JSON by default), or on a Change the choice over what the address
 * says; null to keep the one saved.
 */
export function wantedFormat(service: WebhookService | null, choice: FormatChoice, raw: string): WebhookFormat | null {
  const own = service === null ? null : serviceFormat(service)
  if (own !== null) return own
  if (service === "other") return choice === "auto" || choice === "keep" ? "json" : choice
  if (choice === "keep") return null
  return choice === "auto" ? detectedWebhookFormat(raw) : choice
}

/** Where a Change's format choice starts: the one saved, when one is. */
export function initialFormatChoice(present: boolean): FormatChoice {
  return present ? "keep" : "auto"
}

/**
 * What the format's own variable needs: nothing when it is kept, or when the
 * address says the format wanted and no override is saved; removed when one
 * is saved for nothing; set when the address does not say it.
 */
export function formatWrite(wanted: WebhookFormat | null, raw: string, present: boolean): Write | null {
  if (wanted === null) return null
  const name = settingById("format").variables[0]!.name
  if (wanted === detectedWebhookFormat(raw)) return present ? { variable: name, remove: true } : null
  return { variable: name, value: wanted }
}

/** What the last step says of the format saved: "Slack, read from the address", "JSON, as you chose", "as before". */
export function formatSummary(wanted: WebhookFormat | null, raw: string): string {
  if (wanted === null) return "As before"
  return `${formatLabel(wanted)}, ${wanted === detectedWebhookFormat(raw) ? "read from the address" : "as you chose"}`
}

/** One change the steward makes to a variable: set to a value, or removed. */
export type Write = { variable: string; value: string } | { variable: string; remove: true }

/** An endpoint or an issuer: https, as the backup run and the portal take them. */
export function httpsProblem(raw: string): string | null {
  const value = raw.trim()
  if (value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "That isn't an address. Start it with https://."
  }
  return url.protocol === "https:" ? null : "Use an https:// address."
}

/**
 * A form's fields, keyed by the variable each one sets. On a first setup the
 * required ones are typed; on a Change a field left empty keeps the value on
 * the server, which the page never reads back to fill it in.
 */
export type Fields = Readonly<Record<string, string>>

export type FieldSpec = {
  variable: string
  label: string
  /** Masked, with a Show toggle. */
  secret: boolean
  /** Not needed: "Optional" beside its label. */
  optional: boolean
  placeholder: string
  help?: string
}

function labelOf(id: SettingId, variable: string): string {
  return settingById(id).variables.find((one) => one.name === variable)?.label ?? variable
}

const field = (id: RowId, variable: string, rest: Omit<FieldSpec, "variable" | "label">): FieldSpec => ({ variable, label: labelOf(id, variable), ...rest })

export const OFFSITE_FIELDS: readonly FieldSpec[] = [
  field("offsite", "BACKUP_S3_ENDPOINT", { secret: false, optional: false, placeholder: "https://s3.eu-west-1.example.com", help: "The storage service's address, from your provider." }),
  field("offsite", "BACKUP_S3_BUCKET", { secret: false, optional: false, placeholder: "example-backups" }),
  field("offsite", "BACKUP_S3_ACCESS_KEY_ID", { secret: true, optional: false, placeholder: "xxxxxxxxxxxxxxxx" }),
  field("offsite", "BACKUP_S3_SECRET_ACCESS_KEY", { secret: true, optional: false, placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx" }),
  field("offsite", "BACKUP_S3_REGION", { secret: false, optional: true, placeholder: "eu-west-1" }),
  field("offsite", "BACKUP_S3_PREFIX", { secret: false, optional: true, placeholder: "sitesolide/" }),
]

export const PASSPHRASE_VARIABLE = "BACKUP_ENCRYPTION_PASSPHRASE"

/** The backup run's minimum (dashboard/src/backup/offsite.ts), said before sending; the run judges. */
export const PASSPHRASE_MIN = 16

export const SIGNIN_FIELDS: readonly FieldSpec[] = [
  field("company-signin", "OIDC_ISSUER", { secret: false, optional: false, placeholder: "https://accounts.example.com" }),
  field("company-signin", "OIDC_CLIENT_ID", { secret: false, optional: false, placeholder: "xxxxxxxx.apps.example.com" }),
  field("company-signin", "OIDC_CLIENT_SECRET", { secret: true, optional: false, placeholder: "xxxxxxxxxxxxxxxx" }),
  field("company-signin", "OIDC_ALLOWED_DOMAINS", {
    secret: false,
    optional: false,
    placeholder: "example.com",
    help: "Anyone with an email at these domains can sign in. Separate several with commas.",
  }),
  field("company-signin", "OIDC_ADMIN_EMAILS", { secret: false, optional: true, placeholder: "owner@example.com" }),
  field("company-signin", "OIDC_PROVIDER_NAME", { secret: false, optional: true, placeholder: "Your company account", help: "Shown on the sign-in button." }),
]

const typed = (fields: Fields, variable: string): string => (fields[variable] ?? "").trim()

/** Typed, or kept on the server on a Change. */
function given(fields: Fields, variable: string, present: readonly string[]): boolean {
  return typed(fields, variable) !== "" || present.includes(variable)
}

/** The bucket's details: every required field typed or kept, the endpoint in https, and both keys changed together. */
export function offsiteDetailsReady(fields: Fields, present: readonly string[]): boolean {
  if (httpsProblem(typed(fields, "BACKUP_S3_ENDPOINT")) !== null) return false
  if (!given(fields, "BACKUP_S3_ENDPOINT", present) || !given(fields, "BACKUP_S3_BUCKET", present)) return false
  const access = typed(fields, "BACKUP_S3_ACCESS_KEY_ID") !== ""
  const secret = typed(fields, "BACKUP_S3_SECRET_ACCESS_KEY") !== ""
  if (access || secret) return access && secret
  return present.includes("BACKUP_S3_ACCESS_KEY_ID") && present.includes("BACKUP_S3_SECRET_ACCESS_KEY")
}

/** "9 of 16 characters minimum." while it is too short. */
export function passphraseHint(passphrase: string): Hint | null {
  if (passphrase === "" || passphrase.length >= PASSPHRASE_MIN) return null
  return { text: `${passphrase.length} of ${PASSPHRASE_MIN} characters minimum.`, tone: "plain" }
}

/** Long enough and saved by the owner, or left empty on a Change to keep the one on the server. */
export function passphraseReady(passphrase: string, saved: boolean, present: boolean): boolean {
  if (passphrase === "") return present
  return passphrase.length >= PASSPHRASE_MIN && saved
}

/** The company sign-in's details: issuer, client, secret and domains typed or kept, the issuer in https. */
export function signinReady(fields: Fields, present: readonly string[]): boolean {
  if (httpsProblem(typed(fields, "OIDC_ISSUER")) !== null) return false
  return SIGNIN_FIELDS.filter((one) => !one.optional).every((one) => given(fields, one.variable, present))
}

/** What a form sends: every field typed, trimmed; a passphrase as typed. The rest stays as it is on the server. */
export function writesOf(fields: Fields, specs: readonly FieldSpec[]): Write[] {
  return specs.flatMap((spec) => {
    const value = typed(fields, spec.variable)
    return value === "" ? [] : [{ variable: spec.variable, value }]
  })
}

/** A random passphrase, drawn in the browser: 28 letters and digits nobody confuses, in groups of seven. */
export function drawPassphrase(random: (bytes: Uint32Array) => Uint32Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const draws = random(new Uint32Array(28))
  const groups: string[] = []
  for (let start = 0; start < draws.length; start += 7) {
    groups.push([...draws.subarray(start, start + 7)].map((draw) => alphabet[draw % alphabet.length]).join(""))
  }
  return groups.join("-")
}

// --- Reveal and remove ---------------------------------------------------------------

/** What Reveal shows under a row, in the order the guides ask for them: the setting's variables the file holds. */
export function revealedOf(id: RowId, states: Readonly<Record<SettingId, SettingState>>): { variable: string; label: string }[] {
  const own = states[id].present.map((variable) => ({ variable, label: labelOf(id, variable) }))
  if (id !== "webhook") return own
  return [...own, ...states.format.present.map((variable) => ({ variable, label: labelOf("format", variable) }))]
}

/** What Remove takes away: every variable of the setting the file holds, the webhook's format with it. */
export function removalOf(id: RowId, states: Readonly<Record<SettingId, SettingState>>): Write[] {
  return revealedOf(id, states).map(({ variable }) => ({ variable, remove: true }))
}

/** The sidebar's word on the Server entry: a dot while the heartbeat is not set, red when it fails. */
export function serverSignal(states: Readonly<Record<SettingId, SettingState>> | null): { tone: Tone; label: string } | null {
  if (states === null) return null
  const heartbeat = states.heartbeat
  if (heartbeat.presence === "not-set" || heartbeat.presence === "no-file") return { tone: "attention", label: "heartbeat not set" }
  if (heartbeat.presence === "set" && heartbeat.channel === "failed") return { tone: "error", label: "heartbeat failed" }
  return null
}
