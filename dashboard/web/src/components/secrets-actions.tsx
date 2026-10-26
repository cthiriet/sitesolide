import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { GeneralAccessDialog, type ChangeState } from "@/components/access-general"
import {
  ConfirmDialog,
  PersonUnlockDialog,
  UnlockDialog,
  RestartDialog,
  VariableDialog,
  returnTo,
  type EditTarget,
  type RestartState,
  type FocusReturn,
  type OnRefusal,
} from "@/components/secrets-dialogs"
import { PasswordDialog } from "@/components/secrets-password"
import type { ReadResult } from "@/components/secrets-variables"
import {
  createSecretFile,
  readSecrets,
  readSecretValue,
  restartService,
  restoreSecretFile,
  removeVariable,
  lockSecrets,
} from "@/lib/api"
import {
  cutsTheDashboard,
  unlockStatus,
  pendingFiles,
  pendingVariables,
  restorableFiles,
  refusalOf,
  readVerdict,
  succeeded,
  type UnlockStatus,
  type Refusal,
} from "@/lib/secrets"
import { isPerson, reauthUrl, unlockFailure } from "@/lib/identity"
import { unrestartedSentence } from "@/lib/machine-settings"
import type { ChangeTarget } from "@/lib/access"
import type { GeneralAccess } from "@/lib/types"

/**
 * The actions on a site's secrets and general access, and their dialogs,
 * shared by every section: unlock, read, set, remove, create, restore,
 * change a password, restart, change a site's general access: Public, Restricted, Anyone with the code, a new code.
 *
 * Everything that writes goes through the steward, which judges. The unlock
 * is asked for just in time: a write pressed while locked opens the unlock,
 * then carries on once unlocked here (`require`, which `WriteButton` in
 * components/unlock.tsx wraps). A person's unlock leaves for their provider
 * and comes back to the page, where what they were doing may be kept
 * (`beforeLeave`) and the header says what to press again (`resume`). A 423
 * locks and asks for the password without replaying the action, a 401 hands
 * over to the sign-in, an unreachable steward raises the page's banner, a
 * busy steward is reported where the action took place.
 */

export type FileTarget = { slug: string; file: string }

/** What a write that needs the unlock says about itself, for the unlock and the way back from it. */
export type RequireOptions = {
  /** Just before a person leaves for their provider: what the page keeps for the way back. */
  beforeLeave?: () => void
  /** The control's label, said again on a person's way back: "Unlocked. Press New token to finish." */
  resume?: string
  /** What waits, for the unlock's title: "create a token" reads "Unlock to create a token". */
  purpose?: string
}
export type VariableTarget = FileTarget & { variable: string }

export type SecretsActions = {
  state: UnlockStatus
  /** The server's time, against which the steward's dates are compared. */
  serverNow: number
  /** A lock is in flight. */
  locking: boolean
  /** The refusal of a lock, to be shown at the top of the page. */
  lockError: string
  /** A person's unlock that came back without unlocking, and why, to be shown at the top of the page. */
  unlockNotice: string | null
  /** A person's unlock that came back unlocked: what to press again, "Unlocked. Press New token to finish." */
  resumeNote: string | null
  /**
   * A person signed in, not the owner: they unlock through a forced
   * sign-in at the provider, and their role decides what the steward accepts.
   */
  person: boolean
  /** Changes after every operation: the log is read again. */
  revision: number
  /** The key of the file whose creation is in flight. */
  creation: string | null
  /** Per file, the refusal of a creation. */
  errors: Readonly<Record<string, string>>
  /**
   * The unlock, asked for. `then` runs once unlocked on this page, the
   * owner's; a person leaves for their provider instead, `beforeLeave` run
   * just before, to keep what they were doing for when they come back.
   */
  unlock: (options?: RequireOptions & { then?: () => void }) => void
  lock: () => void
  /**
   * An action that needs the unlock: run now when unlocked, otherwise once
   * unlocked here; a person's unlock leaves for their provider and the
   * gesture is made again on the way back, never replayed.
   */
  require: (action: () => void, options?: RequireOptions) => void
  /** After a change made elsewhere on the page, a store's: the secrets and the log are read again. */
  changed: () => void
  /** A restart with no confirmation, its verdict in the dialog: after *Save & restart*. */
  restartNow: (slug: string) => void
  read: (target: VariableTarget) => Promise<ReadResult>
  add: (target: FileTarget) => void
  edit: (target: VariableTarget) => void
  remove: (target: VariableTarget) => void
  create: (target: FileTarget) => void
  restore: (target: FileTarget) => void
  /** `purpose` names the password in the unlock's title: "Unlock to change the dashboard password". */
  changePassword: (target: VariableTarget, options?: RequireOptions) => void
  /**
   * `plain`: the confirmation names no file, for the Server page, which says
   * the server's settings in words; the restart is the same.
   */
  restart: (slug: string, options?: RequireOptions & { plain?: boolean }) => void
  /**
   * `from`: how the site opens before the change. `warning`, said in the
   * confirmation: who still opens a site restricted with nobody on its list.
   */
  changeAccess: (slug: string, target: ChangeTarget, from: GeneralAccess, warning?: string | null, addresses?: string[]) => void
  /** The common fate of a refusal: the session handed to the sign-in, the unlock asked again; the message to show otherwise. */
  refusal: OnRefusal
}

export const fileKey = ({ slug, file }: FileTarget) => `${slug}/${file}`

const ActionsContext = createContext<SecretsActions | null>(null)

export function useSecretsActions(): SecretsActions {
  const actions = useContext(ActionsContext)
  if (actions === null) throw new Error("useSecretsActions used outside SecretsActionsProvider")
  return actions
}

/** The actions where a page has them, null elsewhere: a page header shown outside a page, *Only the owner's*. */
export function useOptionalSecretsActions(): SecretsActions | null {
  return useContext(ActionsContext)
}

/**
 * Where a person's way back from their provider finds what to press again:
 * this tab's session storage, which may refuse, and then only the header's
 * pill says the unlock went through.
 */
const RESUME_KEY = "sitesolide-resume"

/** A note older than this is left: the unlock it was for is over anyway. */
const RESUME_MS = 10 * 60_000

type Resume = { path: string; label: string; at: number }

function keepResume(resume: Resume) {
  try {
    window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(resume))
  } catch {
    // A storage that refuses loses the note, never the unlock.
  }
}

/** The note left for this address, taken once. */
function takeResume(path: string, now: number): string | null {
  try {
    const text = window.sessionStorage.getItem(RESUME_KEY)
    if (text === null) return null
    window.sessionStorage.removeItem(RESUME_KEY)
    const resume = JSON.parse(text) as Partial<Resume>
    if (resume.path !== path || typeof resume.label !== "string" || typeof resume.at !== "number") return null
    return now - resume.at < RESUME_MS ? resume.label : null
  } catch {
    return null
  }
}

/** The address a person's unlock comes back to, without the reason a refused one leaves in it. */
function currentPath(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete("unlock")
  return `${url.pathname}${url.search}`
}

type Confirmation = FileTarget & { variable: string | null; open: boolean }

/** A dialog that remounts on every opening: nothing from a previous entry reappears. */
type Opening<T> = T & { open: boolean; opening: number }

const NEW_RESTART: RestartState = {
  slug: "",
  plain: false,
  open: false,
  phase: "confirmation",
  start: null,
  verdict: null,
  message: "",
  restoration: null,
  restored: null,
  reconnect: null,
}

/** What waits for an unlock: the action, what a person keeps before leaving, what they press again. */
type Waiting = { then: (() => void) | null; beforeLeave: (() => void) | null; resume: string | null }

const NOTHING_WAITS: Waiting = { then: null, beforeLeave: null, resume: null }

/** Between two reconnection attempts after the dashboard's restart. */
const RECONNECT_MS = 2000

const pause = (ms: number) => new Promise((done) => window.setTimeout(done, ms))

export function SecretsActionsProvider({ children }: { children: ReactNode }) {
  const announce = useAnnounce()
  const { secrets: data, now, offset, sessionExpired, refresh, identity, sso } = useData()
  const person = isPerson(identity)
  const state = unlockStatus(data.until, now, offset)
  const serverNow = now + offset
  const { projects, reload, setUnlockedUntil, reportUnreachable } = data

  const [unlockOpen, setUnlockOpen] = useState(false)
  const [editing, setEditing] = useState<(EditTarget & { open: boolean }) | null>(null)
  const [removal, setRemoval] = useState<Confirmation | null>(null)
  const [restoration, setRestoration] = useState<Confirmation | null>(null)
  const [confirmationInProgress, setConfirmationInProgress] = useState(false)
  const [confirmError, setConfirmError] = useState("")
  const [restartState, setRestartState] = useState<RestartState | null>(null)
  const [password, setPassword] = useState<Opening<VariableTarget> | null>(null)
  const [accessChange, setAccessChange] = useState<ChangeState | null>(null)
  const [creation, setCreation] = useState<string | null>(null)
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [locking, setLocking] = useState(false)
  const [lockError, setLockError] = useState("")
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null)
  const [resumeLabel, setResumeLabel] = useState<string | null>(null)
  const [unlockPurpose, setUnlockPurpose] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  // A person's unlock comes back to this page, with why when it did not go
  // through: said once, and taken off the address. When it went through,
  // what they pressed is said again, so that they press it once more.
  useEffect(() => {
    const url = new URL(window.location.href)
    const reason = url.searchParams.get("unlock")
    const label = takeResume(currentPath(), Date.now())
    if (reason === null) return setResumeLabel(label)
    setUnlockNotice(unlockFailure(reason))
    url.searchParams.delete("unlock")
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  }, [])

  /** The element an action starts from, where focus returns when its dialog closes. */
  const origin = useRef<HTMLElement | null>(null)
  /** What asked for the unlock, carried on once unlocked; dropped when the unlock is cancelled. */
  const afterUnlock = useRef<Waiting>(NOTHING_WAITS)

  function askUnlock(then: (() => void) | null = null, options: RequireOptions = {}) {
    afterUnlock.current = { then, beforeLeave: options.beforeLeave ?? null, resume: options.resume ?? null }
    setUnlockPurpose(options.purpose ?? null)
    setUnlockOpen(true)
  }

  function cancelUnlock() {
    afterUnlock.current = NOTHING_WAITS
    setUnlockOpen(false)
  }

  /** A person leaves for their provider: what they keep, and what to press again on the way back. */
  function leaveToUnlock() {
    const { beforeLeave, resume } = afterUnlock.current
    beforeLeave?.()
    if (resume !== null) keepResume({ path: currentPath(), label: resume, at: Date.now() })
  }

  /** A button that only exists after the next render, to focus as soon as it appears. */
  const focusAfter = useRef<string | null>(null)
  const openings = useRef(0)
  // What is open, read by the dialogs that close: a dialog that gives way to
  // another does not take focus back from it when returning its own.
  const unlockShown = useRef(false)
  const restartShown = useRef(false)
  useEffect(() => {
    unlockShown.current = unlockOpen
  }, [unlockOpen])
  useEffect(() => {
    restartShown.current = restartState?.open ?? false
  }, [restartState?.open])

  // A reconnection wait stops with the provider: it reads nothing more for anyone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The end of an unlock is announced: the values have just been masked again.
  const expired = !state.open && state.expired
  const wasOpen = useRef(state.open)
  useEffect(() => {
    if (wasOpen.current && expired) announce("Secrets locked again: the unlock expired.")
    wasOpen.current = state.open
  }, [state.open, expired, announce])

  const returnFocus: FocusReturn = () => returnTo(origin.current)
  const actionFocusReturn: FocusReturn = () => (unlockShown.current || restartShown.current ? false : returnFocus())
  const restartFocusReturn: FocusReturn = () => (unlockShown.current ? false : returnFocus())

  // Safari does not give focus to a clicked button: the last element pressed
  // serves as the origin when focus stayed on the page.
  const lastPress = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest("button, a[href]") : null
      lastPress.current = target instanceof HTMLElement ? target : null
    }
    document.addEventListener("pointerdown", handlePointerDown, true)
    return () => document.removeEventListener("pointerdown", handlePointerDown, true)
  }, [])

  function rememberOrigin() {
    const active = document.activeElement
    origin.current = active instanceof HTMLElement && active !== document.body ? active : lastPress.current
  }

  function afterAction() {
    void reload()
    setRevision((before) => before + 1)
  }

  function closeDialogs() {
    setEditing((before) => before && { ...before, open: false })
    setRemoval((before) => before && { ...before, open: false })
    setRestoration((before) => before && { ...before, open: false })
    setRestartState((before) => before && { ...before, open: false })
    setPassword((before) => before && { ...before, open: false })
    setAccessChange((before) => before && { ...before, open: false })
  }

  /** The common fate of refusals. Returns the message to show where the action took place. */
  const onRefusal: OnRefusal = (refusal: Refusal) => {
    switch (refusal.kind) {
      case "session":
        closeDialogs()
        setUnlockOpen(false)
        sessionExpired()
        return null
      case "locked":
        unlockShown.current = true
        closeDialogs()
        setUnlockedUntil(null)
        askUnlock()
        // The steward answered: an unreachable banner is left over from a previous read.
        void reload()
        return null
      case "unreachable":
        reportUnreachable()
        return refusal.message
      case "busy":
      case "rejects":
        return refusal.message
    }
  }

  /**
   * An action that requires the token: locked, the page asks for the unlock
   * first, then performs it here; a person's comes back from their provider
   * and presses again.
   */
  function require(action: () => void, options: RequireOptions = {}) {
    rememberOrigin()
    setResumeLabel(null)
    if (!state.open) return askUnlock(action, options)
    action()
  }

  function setFileError(key: string, message: string) {
    setFileErrors(({ [key]: _, ...remaining }) => (message === "" ? remaining : { ...remaining, [key]: message }))
  }

  // --- Unlocking, locking

  function unlocked(until: number) {
    setUnlockedUntil(until)
    setUnlockOpen(false)
    setLockError("")
    const status = unlockStatus(until, Date.now(), offset)
    announce(status.open ? `Changes unlocked for ${status.remainingText}.` : "Changes unlocked.")
    const { then } = afterUnlock.current
    afterUnlock.current = NOTHING_WAITS
    // What asked for the unlock carries on: its dialog, or its change.
    if (then !== null) return then()
    afterAction()
  }

  async function lock() {
    if (locking) return
    setLocking(true)
    setLockError("")
    try {
      const { status, body } = await lockSecrets()
      const refusal = succeeded(status) ? null : refusalOf(status, body)
      // Already locked on the server side: the goal is reached.
      if (refusal === null || refusal.kind === "locked") {
        setUnlockedUntil(null)
        setResumeLabel(null)
        announce("Changes locked")
        return afterAction()
      }
      const message = onRefusal(refusal)
      if (message !== null) setLockError(message)
    } finally {
      setLocking(false)
    }
  }

  // --- Reading a value

  async function readWith(call: () => Promise<{ status: number; body: unknown }>, extract: (body: unknown) => string | null) {
    const { status, body } = await call()
    const value = succeeded(status) ? extract(body) : null
    if (value !== null) {
      // A read is logged: the log shows it.
      setRevision((before) => before + 1)
      if (data.problem !== null) void reload()
      return { value }
    }
    const refusal = refusalOf(status, body)
    // Locked, the password is asked for, and focus returns to the reveal or the copy pressed.
    if (refusal.kind === "locked") rememberOrigin()
    return { message: onRefusal(refusal) }
  }

  const textField = (key: string) => (body: unknown) => {
    const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined
    return typeof value === "string" ? value : null
  }

  function read(target: VariableTarget): Promise<ReadResult> {
    return readWith(() => readSecretValue(target), textField("value"))
  }

  // --- Adding, editing

  function openEditor(target: FileTarget, variable: string | null) {
    require(() => {
      openings.current += 1
      setEditing({ ...target, variable, opening: openings.current, open: true })
    })
  }

  function saved(target: EditTarget, variable: string, restart: boolean) {
    if (restart) restartShown.current = true
    setEditing((before) => before && { ...before, open: false })
    announce(`Saved ${variable} in ${target.file}`)
    afterAction()
    if (restart) void runRestart(target.slug)
  }

  // --- Changing a password

  function changePassword(target: VariableTarget, options: RequireOptions = {}) {
    require(() => {
      openings.current += 1
      setPassword({ ...target, opening: openings.current, open: true })
    }, options)
  }

  // --- Removing, restoring

  function askRemoval(target: VariableTarget) {
    require(() => {
      setConfirmError("")
      setRemoval({ ...target, open: true })
    })
  }

  async function confirmRemoval() {
    if (removal === null || removal.variable === null || confirmationInProgress) return
    const target = { slug: removal.slug, file: removal.file, variable: removal.variable }
    setConfirmationInProgress(true)
    setConfirmError("")
    try {
      const { status, body } = await removeVariable(target)
      if (succeeded(status)) {
        // The row is about to disappear: focus returns to the add button of the same file.
        const addButton = [...document.querySelectorAll<HTMLElement>(`[data-add-variable="${CSS.escape(fileKey(target))}"]`)].find(
          (element) => element.getClientRects().length > 0,
        )
        if (addButton !== undefined) origin.current = addButton
        setRemoval({ ...removal, open: false })
        announce(`Removed ${target.variable} from ${target.file}`)
        return afterAction()
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setConfirmError(message)
    } finally {
      setConfirmationInProgress(false)
    }
  }

  function askRestore(target: FileTarget) {
    require(() => {
      setConfirmError("")
      setRestoration({ ...target, variable: null, open: true })
    })
  }

  async function confirmRestore() {
    if (restoration === null || confirmationInProgress) return
    const target = { slug: restoration.slug, file: restoration.file }
    setConfirmationInProgress(true)
    setConfirmError("")
    try {
      const { status, body } = await restoreSecretFile(target)
      if (succeeded(status)) {
        setRestoration({ ...restoration, open: false })
        announce(`Restored the previous ${target.file}. ${unrestartedSentence(target.slug, target.file, "restore") ?? `Restart ${target.slug} to use it.`}`)
        return afterAction()
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setConfirmError(message)
    } finally {
      setConfirmationInProgress(false)
    }
  }

  // --- Creating a declared file

  function create(target: FileTarget) {
    require(() => void createFile(target))
  }

  async function createFile(target: FileTarget) {
    const key = fileKey(target)
    if (creation !== null) return
    setCreation(key)
    setFileError(key, "")
    try {
      const { status, body } = await createSecretFile(target)
      if (succeeded(status)) {
        announce(`Created ${target.file}`)
        focusAfter.current = `[data-after-creation="${CSS.escape(key)}"]`
        return afterAction()
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setFileError(key, message)
    } finally {
      setCreation(null)
    }
  }

  // The "Create file" button disappears with the created file: focus goes to the next action as soon as it exists.
  useEffect(() => {
    const selector = focusAfter.current
    if (selector === null) return
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.getClientRects().length > 0)
    if (target === undefined) return
    focusAfter.current = null
    target.focus()
  })

  // --- Restarting

  function askRestart(slug: string, { plain = false, ...options }: RequireOptions & { plain?: boolean } = {}) {
    // A person restarts with their session alone, the steward judging their
    // role; the owner restarts from an unlocked Secrets section.
    if (person) {
      rememberOrigin()
      return setRestartState({ ...NEW_RESTART, slug, plain, open: true })
    }
    require(() => setRestartState({ ...NEW_RESTART, slug, plain, open: true }), options)
  }

  /**
   * The dashboard restarted itself: it comes back without the token, which it
   * was keeping in memory. So the page reads the secrets again until they
   * answer locked, riding out the cut, then reads everything again. A session
   * closed by the restart hands over to the sign-in.
   */
  async function waitForReturn() {
    for (;;) {
      await pause(RECONNECT_MS)
      if (!mounted.current) return
      const { status, body } = await readSecrets()
      if (status === 401) return sessionExpired()
      if (status === 200 && body !== null && (body.until ?? null) === null) break
    }
    setUnlockedUntil(null)
    refresh()
    void reload()
    setRevision((before) => before + 1)
    setRestartState((before) => before && { ...before, reconnect: "back" })
    announce("The dashboard is back. Unlock again to change secrets.")
  }

  async function runRestart(slug: string, restored: string | null = null, plain = false) {
    const base = { ...NEW_RESTART, slug, open: true, restored, plain }
    setRestartState({ ...base, phase: "in-progress", start: Date.now() })
    const { status, body } = await restartService({ slug })
    if (succeeded(status) && body !== null && typeof body.verdict?.kind === "string") {
      const verdictText = readVerdict(body.verdict, slug)
      const cuts = cutsTheDashboard(body.verdict)
      setRestartState({ ...base, phase: "verdict", verdict: body.verdict, start: Date.now(), reconnect: cuts ? "waiting" : null })
      announce(`${verdictText.title}. ${verdictText.detail}`)
      if (cuts) return void waitForReturn()
    } else {
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) {
        setRestartState({ ...base, phase: "error", message })
        announce(`Couldn't restart ${slug}. ${message}`)
      }
    }
    afterAction()
  }

  async function restoreAndRestart(slug: string, file: string) {
    setRestartState((before) => before && { ...before, restoration: file, message: "" })
    const { status, body } = await restoreSecretFile({ slug, file })
    if (!succeeded(status)) {
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setRestartState((before) => before && { ...before, restoration: null, message })
      return afterAction()
    }
    announce(`Restored the previous ${file}. Restarting ${slug}.`)
    await runRestart(slug, file)
  }

  // --- General access

  function changeAccess(slug: string, target: ChangeTarget, from: GeneralAccess, warning: string | null = null, addresses: string[] = []) {
    const open = () => {
      openings.current += 1
      setAccessChange({ slug, target, from, warning, addresses, open: true, opening: openings.current })
    }
    // Restricting lets nobody new in: it waits for no unlock. Making a site
    // public, opening it with a code and a new code do.
    if (target === "restricted") {
      rememberOrigin()
      return open()
    }
    // The unlock's title names what waits: "Unlock to make cms public".
    const purpose = target === "public" ? `make ${slug} public` : target === "code" ? `open ${slug} with a code` : `replace ${slug}'s code`
    require(open, target === "renew" ? { purpose, resume: "New code" } : { purpose })
  }

  function onAccessChanged() {
    afterAction()
    // The snapshot follows the Caddy block at the next reading: reading it again straight away costs nothing.
    // The gatekeeper starts the collector as it ends, which writes within a
    // couple of seconds: read once more then, so that the panel, the code
    // included, shows what the server now does without waiting for the
    // half-minute's reading.
    refresh()
    window.setTimeout(refresh, 2500)
  }

  const actions: SecretsActions = {
    state,
    serverNow,
    locking,
    lockError,
    unlockNotice,
    resumeNote: resumeLabel !== null && state.open ? `Unlocked. Press ${resumeLabel} to finish.` : null,
    person,
    revision,
    creation,
    errors: fileErrors,
    unlock: (options) => {
      rememberOrigin()
      askUnlock(options?.then ?? null, options)
    },
    lock: () => void lock(),
    require,
    changed: afterAction,
    restartNow: (slug) => {
      restartShown.current = true
      void runRestart(slug)
    },
    read,
    add: (target) => openEditor(target, null),
    edit: (target) => openEditor(target, target.variable),
    remove: askRemoval,
    create,
    restore: askRestore,
    changePassword,
    restart: askRestart,
    changeAccess,
    refusal: onRefusal,
  }

  const restartedProject = projects?.find((project) => project.slug === restartState?.slug) ?? null

  return (
    <ActionsContext.Provider value={actions}>
      {children}

      {person ? (
        <PersonUnlockDialog
          open={unlockOpen}
          purpose={unlockPurpose}
          providerName={sso.providerName}
          href={reauthUrl(window.location.pathname, window.location.search)}
          onLeave={leaveToUnlock}
          onClose={cancelUnlock}
          focusReturn={returnFocus}
        />
      ) : (
        <UnlockDialog
          open={unlockOpen}
          purpose={unlockPurpose}
          onClose={cancelUnlock}
          onUnlocked={unlocked}
          onRefusal={onRefusal}
          focusReturn={returnFocus}
        />
      )}

      <VariableDialog
        target={editing}
        open={editing?.open ?? false}
        onClose={() => setEditing((before) => before && { ...before, open: false })}
        onSaved={saved}
        onRefusal={onRefusal}
        focusReturn={actionFocusReturn}
      />

      <PasswordDialog
        target={password}
        open={password?.open ?? false}
        onClose={() => setPassword((before) => before && { ...before, open: false })}
        onChange={() => afterAction()}
        onRefusal={onRefusal}
        focusReturn={actionFocusReturn}
      />

      <GeneralAccessDialog
        state={accessChange}
        onClose={() => setAccessChange((before) => before && { ...before, open: false })}
        onChanged={onAccessChanged}
        onRefusal={onRefusal}
        focusReturn={actionFocusReturn}
      />

      <ConfirmDialog
        open={removal?.open ?? false}
        title={
          <>
            Remove <span className="font-mono">{removal?.variable}</span>?
          </>
        }
        description={
          <>
            It goes out of <span className="font-mono">{removal?.file}</span>.{" "}
            {removal === null
              ? null
              : (unrestartedSentence(removal.slug, removal.file, "remove") ?? `${removal.slug} keeps using it until it restarts.`)}{" "}
            Restore previous can bring it back until the next change.
          </>
        }
        action="Remove"
        actionInProgress="Removing…"
        destructive
        inProgress={confirmationInProgress}
        error={confirmError}
        onConfirm={() => void confirmRemoval()}
        onClose={() => setRemoval((before) => before && { ...before, open: false })}
        focusReturn={actionFocusReturn}
      />

      <ConfirmDialog
        open={restoration?.open ?? false}
        title={
          <>
            Restore the previous <span className="font-mono">{restoration?.file}</span>?
          </>
        }
        description={`The whole file goes back to how it was before its last change, and may hold a key you meant to retire. ${
          restoration === null
            ? ""
            : (unrestartedSentence(restoration.slug, restoration.file, "restore") ?? "The service keeps its current values until it restarts.")
        }`}
        action="Restore"
        actionInProgress="Restoring…"
        inProgress={confirmationInProgress}
        error={confirmError}
        onConfirm={() => void confirmRestore()}
        onClose={() => setRestoration((before) => before && { ...before, open: false })}
        focusReturn={actionFocusReturn}
      />

      <RestartDialog
        state={restartState}
        pending={restartedProject === null ? [] : pendingFiles(restartedProject)}
        pendingVariables={restartedProject !== null && pendingVariables(restartedProject)}
        restorable={restartedProject === null ? [] : restorableFiles(restartedProject)}
        storePrevious={restartedProject?.store?.previous === true && restartedProject.store.may.restore}
        onConfirm={(slug) => void runRestart(slug, restartState?.phase === "error" ? restartState.restored : null, restartState?.plain ?? false)}
        onRestore={(slug, file) => void restoreAndRestart(slug, file)}
        onClose={() => setRestartState((before) => before && { ...before, open: false })}
        focusReturn={restartFocusReturn}
      />
    </ActionsContext.Provider>
  )
}
