import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { PortalDialog, type ToggleState } from "@/components/portal"
import { ContentDialog } from "@/components/secrets-content"
import {
  ConfirmDialog,
  UnlockDialog,
  RestartDialog,
  VariableDialog,
  type EditTarget,
  type RestartState,
  type FocusReturn,
  type OnRefusal,
} from "@/components/secrets-dialogs"
import { PasswordDialog } from "@/components/secrets-password"
import type { ReadResult } from "@/components/secrets-variables"
import {
  createSecretFile,
  readSecretContent,
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
  restorableFiles,
  refusalOf,
  readVerdict,
  succeeded,
  type UnlockStatus,
  type Refusal,
} from "@/lib/secrets"

/**
 * The actions on a site's secrets and portal, and their dialogs, shared by
 * every section: unlock, read, set, remove, create, restore, replace a file,
 * change a password, restart, turn the portal on or off.
 *
 * Everything that writes goes through the steward, which judges. A 423 locks
 * and asks for the password without replaying the action, a 401 hands over to
 * the sign-in, an unreachable steward raises the page's banner, a busy steward
 * is reported where the action took place.
 */

export type FileTarget = { slug: string; file: string }
export type VariableTarget = FileTarget & { variable: string }

export type SecretsActions = {
  state: UnlockStatus
  /** The server's time, against which the steward's dates are compared. */
  serverNow: number
  /** A lock is in flight. */
  locking: boolean
  /** The refusal of a lock, to be shown at the top of the page. */
  lockError: string
  /** Changes after every operation: the log is read again. */
  revision: number
  /** The key of the file whose creation is in flight. */
  creation: string | null
  /** Per file, the refusal of a creation. */
  errors: Readonly<Record<string, string>>
  /** The last successful action on this site's portal, which the repository has to follow. */
  portalChanged: { active: boolean } | null
  /** The header's lock button, where focus returns after a forced lock. */
  lockButtonRef: (element: HTMLButtonElement | null) => void
  unlock: () => void
  lock: () => void
  read: (target: VariableTarget) => Promise<ReadResult>
  readContent: (target: FileTarget) => Promise<ReadResult>
  add: (target: FileTarget) => void
  modifier: (target: VariableTarget) => void
  remove: (target: VariableTarget) => void
  create: (target: FileTarget) => void
  restore: (target: FileTarget) => void
  replace: (target: FileTarget) => void
  changePassword: (target: VariableTarget) => void
  restart: (slug: string) => void
  togglePortal: (slug: string, active: boolean) => void
}

export const fileKey = ({ slug, file }: FileTarget) => `${slug}/${file}`

const ActionsContext = createContext<SecretsActions | null>(null)

export function useSecretsActions(): SecretsActions {
  const actions = useContext(ActionsContext)
  if (actions === null) throw new Error("useSecretsActions used outside SecretsActionsProvider")
  return actions
}

type Confirmation = FileTarget & { variable: string | null; open: boolean }

/** A dialog that remounts on every opening: nothing from a previous entry reappears. */
type Opening<T> = T & { open: boolean; opening: number }

const NEW_RESTART: RestartState = {
  slug: "",
  open: false,
  phase: "confirmation",
  start: null,
  verdict: null,
  message: "",
  restoration: null,
  restored: null,
  reconnect: null,
}

/** Between two reconnection attempts after the dashboard's restart. */
const RECONNECT_MS = 2000

const pause = (ms: number) => new Promise((done) => window.setTimeout(done, ms))

export function SecretsActionsProvider({ children }: { children: ReactNode }) {
  const announce = useAnnounce()
  const { secrets: data, guests, now, offset, sessionExpired, refresh } = useData()
  const state = unlockStatus(data.until, now, offset)
  const serverNow = now + offset
  const { projects, reload, setUnlockedUntil, reportUnreachable } = data

  const [unlockOpen, setUnlockOpen] = useState(false)
  const [editing, setEditing] = useState<(EditTarget & { open: boolean }) | null>(null)
  const [removal, setRemoval] = useState<Confirmation | null>(null)
  const [restoration, setRestauration] = useState<Confirmation | null>(null)
  const [confirmationEnCours, setConfirmationEnCours] = useState(false)
  const [confirmError, setConfirmError] = useState("")
  const [restartState, setRestartState] = useState<RestartState | null>(null)
  const [replacement, setReplacement] = useState<Opening<FileTarget> | null>(null)
  const [password, setPassword] = useState<Opening<VariableTarget> | null>(null)
  const [portalToggle, setPortalToggle] = useState<ToggleState | null>(null)
  const [portalChanged, setPortalChanged] = useState<{ active: boolean } | null>(null)
  const [creation, setCreation] = useState<string | null>(null)
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [locking, setLocking] = useState(false)
  const [lockError, setLockError] = useState("")
  const [revision, setRevision] = useState(0)

  /** The element an action starts from, where focus returns when its dialog closes. */
  const origin = useRef<HTMLElement | null>(null)
  /**
   * The lock buttons: the page header renders its actions twice, for the
   * computer and for the phone, and only one of the two is displayed.
   */
  const lockButtons = useRef(new Set<HTMLButtonElement>())
  const lockButtonRef = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) {
      for (const button of lockButtons.current) if (!button.isConnected) lockButtons.current.delete(button)
      return
    }
    lockButtons.current.add(element)
  }, [])
  const visibleLockButton = () =>
    [...lockButtons.current].find((button) => button.isConnected && button.getClientRects().length > 0) ?? null

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
  const monte = useRef(true)
  useEffect(() => {
    monte.current = true
    return () => {
      monte.current = false
    }
  }, [])

  // The end of an unlock is announced: the values have just been masked again.
  const expired = !state.open && state.expired
  const wasOpen = useRef(state.open)
  useEffect(() => {
    if (wasOpen.current && expired) announce("Secrets locked again: the unlock expired.")
    wasOpen.current = state.open
  }, [state.open, expired, announce])

  const returnFocus = (): HTMLElement | boolean => {
    const element = origin.current
    return element !== null && element.isConnected && element.getClientRects().length > 0 ? element : true
  }
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
    setRestauration((before) => before && { ...before, open: false })
    setRestartState((before) => before && { ...before, open: false })
    setReplacement((before) => before && { ...before, open: false })
    setPassword((before) => before && { ...before, open: false })
    setPortalToggle((before) => before && { ...before, open: false })
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
        setUnlockOpen(true)
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

  /** An action that requires the token: locked, the page asks for the password first, without replaying the action. */
  function require(action: () => void) {
    rememberOrigin()
    if (!state.open) return setUnlockOpen(true)
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
    announce(`Secrets ${unlockStatus(until, Date.now(), offset).label.toLowerCase()}`)
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
        announce("Secrets locked")
        return afterAction()
      }
      const message = onRefusal(refusal)
      if (message !== null) setLockError(message)
    } finally {
      setLocking(false)
    }
  }

  // --- Reading a value or contents

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
    // Locked, focus will return to the lock button after the password.
    if (refusal.kind === "locked") origin.current = visibleLockButton()
    return { message: onRefusal(refusal) }
  }

  const textField = (key: string) => (body: unknown) => {
    const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined
    return typeof value === "string" ? value : null
  }

  function read(target: VariableTarget): Promise<ReadResult> {
    return readWith(() => readSecretValue(target), textField("value"))
  }

  function readContent(target: FileTarget): Promise<ReadResult> {
    return readWith(() => readSecretContent(target), textField("content"))
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

  // --- Replacing a file read in one go

  function replace(target: FileTarget) {
    require(() => {
      openings.current += 1
      setReplacement({ ...target, opening: openings.current, open: true })
    })
  }

  function replaced(target: FileTarget, restart: boolean) {
    if (restart) restartShown.current = true
    setReplacement((before) => before && { ...before, open: false })
    announce(`Replaced ${target.file}`)
    afterAction()
    if (restart) void runRestart(target.slug)
  }

  // --- Changing a password

  function changePassword(target: VariableTarget) {
    require(() => {
      openings.current += 1
      setPassword({ ...target, opening: openings.current, open: true })
    })
  }

  // --- Removing, restoring

  function askRemoval(target: VariableTarget) {
    require(() => {
      setConfirmError("")
      setRemoval({ ...target, open: true })
    })
  }

  async function confirmRemoval() {
    if (removal === null || removal.variable === null || confirmationEnCours) return
    const target = { slug: removal.slug, file: removal.file, variable: removal.variable }
    setConfirmationEnCours(true)
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
      setConfirmationEnCours(false)
    }
  }

  function askRestore(target: FileTarget) {
    require(() => {
      setConfirmError("")
      setRestauration({ ...target, variable: null, open: true })
    })
  }

  async function confirmRestore() {
    if (restoration === null || confirmationEnCours) return
    const target = { slug: restoration.slug, file: restoration.file }
    setConfirmationEnCours(true)
    setConfirmError("")
    try {
      const { status, body } = await restoreSecretFile(target)
      if (succeeded(status)) {
        setRestauration({ ...restoration, open: false })
        announce(`Restored the previous ${target.file}. Restart ${target.slug} to use it.`)
        return afterAction()
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setConfirmError(message)
    } finally {
      setConfirmationEnCours(false)
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

  function askRestart(slug: string) {
    require(() => setRestartState({ ...NEW_RESTART, slug, open: true }))
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
      if (!monte.current) return
      const { status, body } = await readSecrets()
      if (status === 401) return sessionExpired()
      if (status === 200 && body !== null && (body.until ?? null) === null) break
    }
    setUnlockedUntil(null)
    refresh()
    void reload()
    void guests.reload()
    setRevision((before) => before + 1)
    setRestartState((before) => before && { ...before, reconnect: "back" })
    announce("The dashboard is back. Unlock again to change secrets.")
  }

  async function runRestart(slug: string, restored: string | null = null) {
    const base = { ...NEW_RESTART, slug, open: true, restored }
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

  // --- The portal

  function togglePortal(slug: string, active: boolean) {
    require(() => {
      openings.current += 1
      setPortalToggle({ slug, active, open: true, opening: openings.current })
    })
  }

  function onPortalToggled(active: boolean) {
    setPortalChanged({ active })
    afterAction()
    // The snapshot follows the Caddy block at the next reading: reading it again straight away costs nothing.
    refresh()
  }

  const actions: SecretsActions = {
    state,
    serverNow,
    locking,
    lockError,
    revision,
    creation,
    errors: fileErrors,
    portalChanged,
    lockButtonRef,
    unlock: () => {
      rememberOrigin()
      setUnlockOpen(true)
    },
    lock: () => void lock(),
    read,
    readContent,
    add: (target) => openEditor(target, null),
    modifier: (target) => openEditor(target, target.variable),
    remove: askRemoval,
    create,
    restore: askRestore,
    replace,
    changePassword,
    restart: askRestart,
    togglePortal,
  }

  const restartedProject = projects?.find((project) => project.slug === restartState?.slug) ?? null
  const replacedProject = projects?.find((project) => project.slug === replacement?.slug) ?? null

  return (
    <ActionsContext.Provider value={actions}>
      {children}

      <UnlockDialog
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        onUnlocked={unlocked}
        onRefusal={onRefusal}
        focusReturn={returnFocus}
      />

      <VariableDialog
        target={editing}
        open={editing?.open ?? false}
        onClose={() => setEditing((before) => before && { ...before, open: false })}
        onSaved={saved}
        onRefusal={onRefusal}
        focusReturn={actionFocusReturn}
      />

      <ContentDialog
        target={replacement}
        open={replacement?.open ?? false}
        writeOnly={replacedProject?.files.find((file) => file.name === replacement?.file)?.readable === false}
        restartable={replacedProject?.service != null}
        onClose={() => setReplacement((before) => before && { ...before, open: false })}
        onReplaced={replaced}
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

      <PortalDialog
        state={portalToggle}
        onClose={() => setPortalToggle((before) => before && { ...before, open: false })}
        onToggled={onPortalToggled}
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
            It goes out of <span className="font-mono">{removal?.file}</span>. {removal?.slug} keeps using it until it
            restarts, and Restore previous can bring it back until the next change.
          </>
        }
        action="Remove"
        actionEnCours="Removing…"
        destructive
        inProgress={confirmationEnCours}
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
        description="The whole file goes back to how it was before its last change, and may hold a key you meant to retire. The service keeps its current values until it restarts."
        action="Restore"
        actionEnCours="Restoring…"
        inProgress={confirmationEnCours}
        error={confirmError}
        onConfirm={() => void confirmRestore()}
        onClose={() => setRestauration((before) => before && { ...before, open: false })}
        focusReturn={actionFocusReturn}
      />

      <RestartDialog
        state={restartState}
        pending={restartedProject === null ? [] : pendingFiles(restartedProject)}
        restorable={restartedProject === null ? [] : restorableFiles(restartedProject)}
        onConfirm={(slug) => void runRestart(slug, restartState?.phase === "error" ? restartState.restored : null)}
        onRestore={(slug, file) => void restoreAndRestart(slug, file)}
        onClose={() => setRestartState((before) => before && { ...before, open: false })}
        focusReturn={restartFocusReturn}
      />
    </ActionsContext.Provider>
  )
}
