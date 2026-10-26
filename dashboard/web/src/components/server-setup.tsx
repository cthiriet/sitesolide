import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { Asterisk, BellRing, Check, Cloud, Eye, EyeOff, HeartPulse, LogIn, RotateCw, UserKey, X, type LucideIcon } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { RowMenu } from "@/components/data-table"
import { InternalLink } from "@/components/navigation"
import { SeverityIcon } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { ConfirmDialog, returnTo, type FocusReturn } from "@/components/secrets-dialogs"
import { SetupGuide, type GuideOpening } from "@/components/setup-guide"
import { LockGlyph, WriteMenuItem } from "@/components/unlock"
import { readBackups, readSecretsLog, removeVariable } from "@/lib/api"
import { isPerson } from "@/lib/identity"
import { settingById, settingState, type SettingId, type SettingState } from "@/lib/machine-settings"
import { PAGE_TITLE_ID, siteUrl } from "@/lib/pages"
import { REVEAL_MS, hideCountdown, refusalOf, succeeded } from "@/lib/secrets"
import {
  DELIVERED_SERVER_MS,
  MONITOR_PASS_MS,
  NO_PREFS,
  changeDates,
  proofPhase,
  readSetupPrefs,
  removalOf,
  revealedOf,
  rowSpec,
  storeSetupPrefs,
  withSkipped,
  type GuideId,
  type GuideStart,
  type MenuEntry,
  type OffsiteReading,
  type Proof,
  type RowId,
  type RowInputs,
  type RowView,
  type SetupPrefs,
} from "@/lib/server-setup"
import { TONE_TEXT } from "@/lib/tones"
import type { LogEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * The server's own settings, the same rows in two places: the Server page,
 * every one of them, and the setup guide on Sites, what is still missing.
 * One provider per page holds what both read (the steward's listing turned
 * into each setting's state, the dates from its log, the backups' word on
 * the offsite copy, the heartbeat's first ping) and the dialogs both open:
 * the guides, the removal, the toasts. The passwords and the restarts keep
 * the dialogs of the Secrets section, through `useSecretsActions`.
 */

// --- What lives beyond a page --------------------------------------------------

/** A value shared by every page of the tab: the viewer's choices, and the first ping awaited. */
function store<T>(initial: () => T, save: (value: T) => void = () => {}) {
  let value: T | null = null
  const listeners = new Set<() => void>()
  return {
    get: (): T => (value ??= initial()),
    set: (next: T) => {
      value = next
      save(next)
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** The guide hidden, the items skipped: this browser's, under one key, names only (`readSetupPrefs`). */
const prefsStore = store<SetupPrefs>(
  () => readSetupPrefs(() => window.localStorage),
  (prefs) => void storeSetupPrefs(() => window.localStorage, prefs),
)

/**
 * The heartbeat's first ping after a save: in memory, for this tab only, so
 * that the wait carries on from the Sites panel to the Server page and back.
 * A date, never the address.
 */
const proofStore = store<Proof | null>(() => null)

function usePrefs(): SetupPrefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, () => NO_PREFS)
}

function useProof(): Proof | null {
  return useSyncExternalStore(proofStore.subscribe, proofStore.get, () => null)
}

// --- The toasts ------------------------------------------------------------------

export type ToastSpec = { text: string; action?: { label: string; run: () => void } }

/**
 * One toast at a time, at the foot of the screen: what a choice of the
 * viewer's just did, with Undo. Its words go through the page's one live
 * region, not through the toast.
 */
function Toast({ toast, onClose }: { toast: ToastSpec & { key: number }; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, toast.action === undefined ? 4600 : 7500)
    return () => window.clearTimeout(timer)
  }, [toast, onClose])
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4 max-md:bottom-24">
      <div className="pointer-events-auto flex max-w-[37.5rem] min-w-0 items-center gap-2.5 rounded-xl border bg-popover py-2 pr-2 pl-3.5 text-[0.8125rem] leading-5 shadow-float">
        {toast.action === undefined && <Check aria-hidden="true" className="size-4 shrink-0 text-ok-text" />}
        <span className="min-w-0 flex-1 text-pretty">{toast.text}</span>
        {toast.action !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onClose()
              toast.action?.run()
            }}
            className="max-md:h-9"
          >
            {toast.action.label}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onClose} className="text-muted-foreground hover:text-foreground max-md:size-9">
          <X />
        </Button>
      </div>
    </div>
  )
}

// --- The provider ------------------------------------------------------------------

type Revealed = { id: RowId; values: { label: string; value: string }[]; at: number }

export type ServerSetup = {
  /** The owner, with the steward's listing read: the rows can be drawn. */
  ready: boolean
  /** The owner: a person sees none of this, and the steward refuses them anyway. */
  owner: boolean
  inputs: RowInputs
  prefs: SetupPrefs
  hidden: boolean
  guideOpen: GuideId | null
  openGuide: (id: GuideId, start: GuideStart) => void
  menu: (id: RowId, entry: MenuEntry) => void
  changePassword: (id: "dashboard-password" | "portal-password") => void
  hideGuide: () => void
  showGuide: () => void
  skip: (id: GuideId, skip: boolean) => void
  toast: (toast: ToastSpec) => void
  revealed: Revealed | null
  revealing: RowId | null
  revealError: { id: RowId; message: string } | null
  hideReveal: () => void
  clock: number
}

const SetupContext = createContext<ServerSetup | null>(null)

export function useServerSetup(): ServerSetup {
  const setup = useContext(SetupContext)
  if (setup === null) throw new Error("useServerSetup used outside ServerSetupProvider")
  return setup
}

/** The rows' words move on with the clock while the first ping is awaited: every second then, every ten otherwise. */
function useTick(fast: boolean): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (!fast) return
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [fast])
  return tick
}

/** While the first ping is awaited, the page reads the snapshot more often than its half minute: the monitor's word comes with it. */
const PROOF_REFRESH_MS = 10_000

/** The removal's words, one per setting a guide sets up. */
const REMOVAL: Readonly<Partial<Record<RowId, { title: string; description: string }>>> = {
  heartbeat: { title: "Remove the heartbeat?", description: "The monitor stops pinging. Nothing outside the server will notice if it goes down." },
  webhook: { title: "Remove the alert webhook?", description: "The monitor stops posting messages when a site goes down or recovers." },
  offsite: {
    title: "Remove the offsite copy?",
    description:
      "Its settings are deleted. Snapshots stay on this server, and nothing is copied offsite until you set it up again. Keep the passphrase: the copy already in the bucket needs it.",
  },
  "company-signin": {
    title: "Remove company sign-in?",
    description: "People can no longer sign in with their company account. The portal applies this when it restarts.",
  },
}

/**
 * The server's settings for one page. `place` says where the toasts send the
 * viewer back: Sites, where the guide lives, or the Server page.
 */
export function ServerSetupProvider({ place, children }: { place: "sites" | "server"; children: ReactNode }) {
  const announce = useAnnounce()
  const actions = useSecretsActions()
  const { secrets, snapshot, offset, identity, refresh } = useData()
  const owner = !isPerson(identity)
  const prefs = usePrefs()
  const proof = useProof()
  const [guide, setGuide] = useState<GuideOpening | null>(null)
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [offsite, setOffsite] = useState<OffsiteReading | null>(null)
  const [toast, setToast] = useState<(ToastSpec & { key: number }) | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [revealing, setRevealing] = useState<RowId | null>(null)
  const [revealError, setRevealError] = useState<{ id: RowId; message: string } | null>(null)
  const [removal, setRemoval] = useState<{ id: RowId; open: boolean } | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removalError, setRemovalError] = useState("")
  const origin = useRef<HTMLElement | null>(null)
  const toasts = useRef(0)

  const projects = owner ? secrets.projects : null
  const states = useMemo(
    () => settingState(projects, snapshot?.discrepancies ?? [], snapshot?.alerting ?? null),
    [projects, snapshot?.discrepancies, snapshot?.alerting],
  )
  const alerting = snapshot?.alerting ?? null
  const phase = proof === null ? null : proofPhase(proof, alerting)
  const clock = useTick(phase === "waiting" || phase === "delivered" || revealed !== null)
  const serverNow = clock + offset

  // The dates: the steward's log of the two platform sites, read again after every change.
  useEffect(() => {
    if (!owner || projects === null) return
    let current = true
    void Promise.all([readSecretsLog("dashboard"), readSecretsLog("portal")]).then((answers) => {
      if (!current) return
      const entries = answers.flatMap(({ status, body }) => (succeeded(status) && body !== null && Array.isArray(body.entries) ? body.entries : []))
      setLog(entries)
    })
    return () => {
      current = false
    }
  }, [owner, projects === null, actions.revision])

  // The backups' word on the offsite copy, once it is set: where it goes, or why the last run could not use it.
  const offsiteSet = states.offsite.presence === "set"
  useEffect(() => {
    if (!owner || !offsiteSet) return setOffsite(null)
    let current = true
    void readBackups("dashboard").then(({ status, body }) => {
      if (!current) return
      setOffsite(succeeded(status) && body !== null && typeof body.backups === "object" ? body.backups.offsite : null)
    })
    return () => {
      current = false
    }
  }, [owner, offsiteSet, actions.revision])

  // The first ping: the snapshot read more often while it is awaited, its arrival dated, the record let go once said.
  useEffect(() => {
    if (phase !== "waiting") return
    const timer = window.setInterval(refresh, PROOF_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [phase, refresh])
  useEffect(() => {
    if (proof === null) return
    if (phase === "delivered" && proof.deliveredAt === null) proofStore.set({ ...proof, deliveredAt: serverNow })
    else if (phase === "delivered" && proof.deliveredAt !== null && serverNow - proof.deliveredAt > DELIVERED_SERVER_MS && guide?.id !== "heartbeat") proofStore.set(null)
    else if (phase === "unknown" && guide?.id !== "heartbeat") proofStore.set(null)
    // Removed since, elsewhere: let go once the listing has had time to say so, not in the instant after the save.
    else if (states.heartbeat.presence !== "set" && serverNow - proof.savedAt > MONITOR_PASS_MS) proofStore.set(null)
  }, [proof, phase, serverNow, guide?.id, states.heartbeat.presence])

  // A revealed value: thirty seconds, masked again on locking, the tab hidden, the page left.
  const unlocked = actions.state.open
  const unlockedNow = useRef(unlocked)
  useEffect(() => {
    unlockedNow.current = unlocked
    if (!unlocked) setRevealed(null)
  }, [unlocked])
  useEffect(() => {
    if (revealed === null) return
    const timer = window.setTimeout(() => setRevealed(null), revealed.at + REVEAL_MS - Date.now())
    const hideNow = () => flushSync(() => setRevealed(null))
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hideNow()
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", hideNow)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", hideNow)
    }
  }, [revealed])

  const showToast = useCallback(
    (next: ToastSpec) => {
      toasts.current += 1
      setToast({ ...next, key: toasts.current })
      announce(next.text)
    },
    [announce],
  )
  const closeToast = useCallback(() => setToast(null), [])

  function rememberOrigin() {
    const active = document.activeElement
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  const focusReturn: FocusReturn = () => returnTo(origin.current)
  const focusTitle = () => document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true })

  function openGuide(id: GuideId, start: GuideStart) {
    rememberOrigin()
    setGuide((before) => ({ id, start, open: true, opening: (before?.opening ?? 0) + 1 }))
  }

  function closeGuide() {
    if (guide?.id === "heartbeat" && proof !== null && phase === "delivered") proofStore.set({ ...proof, seen: true })
    setGuide((before) => before && { ...before, open: false })
  }

  async function reveal(id: RowId) {
    if (revealed?.id === id) {
      setRevealed(null)
      return announce(`${rowSpec(id).name} hidden`)
    }
    const setting = settingById(id)
    setRevealing(id)
    setRevealError(null)
    try {
      const values: Revealed["values"] = []
      for (const { variable, label } of revealedOf(id, states)) {
        const result = await actions.read({ slug: setting.slug, file: setting.file, variable })
        if (!("value" in result)) {
          if (result.message !== null) setRevealError({ id, message: result.message })
          return
        }
        values.push({ label, value: result.value })
      }
      // A value that arrives after a lock or a tab change is not displayed.
      if (!unlockedNow.current || document.visibilityState === "hidden") return
      setRevealed({ id, values, at: Date.now() })
      announce(`${rowSpec(id).name} shown for ${REVEAL_MS / 1000} seconds`)
    } finally {
      setRevealing(null)
    }
  }

  async function confirmRemoval() {
    if (removal === null || removing) return
    const { id } = removal
    const setting = settingById(id)
    setRemoving(true)
    setRemovalError("")
    try {
      for (const write of removalOf(id, states)) {
        const { status, body } = await removeVariable({ slug: setting.slug, file: setting.file, variable: write.variable })
        if (succeeded(status)) continue
        const refusal = refusalOf(status, body)
        // Locked on the way: the unlock is asked again, and the removal is pressed again, never replayed.
        if (refusal.kind === "locked") setRemoval({ id, open: false })
        const message = actions.refusal(refusal)
        if (message !== null) setRemovalError(message)
        return actions.changed()
      }
      setRemoval({ id, open: false })
      if (id === "heartbeat") proofStore.set(null)
      if (revealed?.id === id) setRevealed(null)
      actions.changed()
      refresh()
      showToast({ text: `${rowSpec(id).name} removed.` })
    } finally {
      setRemoving(false)
    }
  }

  function menu(id: RowId, entry: MenuEntry) {
    const setting = settingById(id)
    if (entry === "reveal") return void reveal(id)
    if (entry === "restart") return actions.restart(setting.slug, { plain: true, purpose: `restart the ${setting.slug}` })
    if (entry === "remove") {
      rememberOrigin()
      setRemovalError("")
      return setRemoval({ id, open: true })
    }
    if (id === "offsite" || id === "company-signin") skip(id, entry === "skip")
  }

  function skip(id: GuideId, skipped: boolean) {
    const before = prefsStore.get()
    prefsStore.set(withSkipped(before, id, skipped))
    focusTitle()
    const name = rowSpec(id).name
    if (!skipped) return showToast({ text: `${name} will show on Sites again.` })
    showToast({
      text: place === "server" ? `${name} skipped. It no longer shows on Sites.` : `${name} skipped. You can set it up on the Server page.`,
      action: { label: "Undo", run: () => prefsStore.set(withSkipped(prefsStore.get(), id, false)) },
    })
  }

  function hideGuide() {
    prefsStore.set({ ...prefsStore.get(), hidden: true })
    focusTitle()
    showToast({
      text: "Setup guide hidden. Every setting stays on the Server page.",
      action: {
        label: "Undo",
        run: () => {
          prefsStore.set({ ...prefsStore.get(), hidden: false })
          window.setTimeout(() => document.querySelector<HTMLElement>("[data-setup-menu]")?.focus({ preventScroll: true }), 0)
        },
      },
    })
  }

  function showGuide() {
    prefsStore.set({ ...prefsStore.get(), hidden: false })
    focusTitle()
    showToast({ text: "The setup guide is back on Sites." })
  }

  function changePassword(id: "dashboard-password" | "portal-password") {
    const setting = settingById(id)
    actions.changePassword({ slug: setting.slug, file: setting.file, variable: setting.variables[0]!.name }, { purpose: `change the ${rowSpec(id).noun}` })
  }

  const changed = useMemo(() => changeDates(states, log), [states, log])
  const skippedSet = useMemo(() => new Set<RowId>(prefs.skipped), [prefs.skipped])
  const inputs: RowInputs = { states, alerting, serverNow, changed, proof, offsite, skipped: skippedSet }
  const ready = owner && projects !== null && states.heartbeat.presence !== "unknown"

  const value: ServerSetup = {
    ready,
    owner,
    inputs,
    prefs,
    hidden: prefs.hidden,
    guideOpen: guide?.open === true ? guide.id : null,
    openGuide,
    menu,
    changePassword,
    hideGuide,
    showGuide,
    skip,
    toast: showToast,
    revealed,
    revealing,
    revealError,
    hideReveal: () => setRevealed(null),
    clock,
  }

  const removed = removal === null ? null : REMOVAL[removal.id] ?? null

  return (
    <SetupContext.Provider value={value}>
      {children}
      <SetupGuide
        guide={guide}
        states={states}
        alerting={alerting}
        proof={proof}
        serverNow={serverNow}
        onProof={(savedAt) => proofStore.set({ savedAt, deliveredAt: null, seen: false })}
        onClose={closeGuide}
        focusReturn={focusReturn}
      />
      <ConfirmDialog
        open={removal?.open ?? false}
        title={removed?.title ?? ""}
        description={removed?.description ?? ""}
        action="Remove"
        actionInProgress="Removing…"
        destructive
        inProgress={removing}
        error={removalError}
        onConfirm={() => void confirmRemoval()}
        onClose={() => setRemoval((before) => before && { ...before, open: false })}
        focusReturn={focusReturn}
      />
      {toast !== null && <Toast key={toast.key} toast={toast} onClose={closeToast} />}
    </SetupContext.Provider>
  )
}

/** Every setting in the catalogue's state, for the sidebar: the owner's, null for a person or before the listing. */
export function useSettingStates(): Readonly<Record<SettingId, SettingState>> | null {
  const { secrets, snapshot, identity } = useData()
  const projects = isPerson(identity) ? null : secrets.projects
  return useMemo(
    () => (projects === null ? null : settingState(projects, snapshot?.discrepancies ?? [], snapshot?.alerting ?? null)),
    [projects, snapshot?.discrepancies, snapshot?.alerting],
  )
}

// --- One row, two places ---------------------------------------------------------------

/**
 * The icon of each setting, its guide's and its row's. None borrows another
 * meaning (web/DESIGN.md section 5, *Icons*): `Cloud` is the offsite copy
 * there as here.
 */
export const ROW_ICONS: Readonly<Record<RowId, LucideIcon>> = {
  heartbeat: HeartPulse,
  webhook: BellRing,
  offsite: Cloud,
  "company-signin": LogIn,
  "dashboard-password": UserKey,
  "portal-password": Asterisk,
}

const MENU_WORDS: Readonly<Record<MenuEntry, string>> = {
  reveal: "Reveal for 30 s",
  restart: "Restart",
  skip: "Skip",
  unskip: "Unskip",
  remove: "Remove",
}

/** The row's "..." and its items: Reveal, Restart, Skip or Unskip, then Remove under a separator. */
function RowEntries({ view, name }: { view: RowView; name: string }) {
  const setup = useServerSetup()
  const actions = useSecretsActions()
  const locked = !actions.state.open
  const spec = rowSpec(view.id)
  const setting = settingById(view.id)
  const shown = setup.revealed?.id === view.id
  const rest = view.menu.filter((entry) => entry !== "remove")
  return (
    <RowMenu label={`More for ${name}`}>
      {rest.map((entry) => {
        if (entry === "reveal") {
          return shown ? (
            <DropdownMenuItem key={entry} onClick={() => setup.hideReveal()} className="h-9">
              <EyeOff />
              Hide value
            </DropdownMenuItem>
          ) : (
            <WriteMenuItem key={entry} onPress={() => setup.menu(view.id, "reveal")} purpose={`reveal the ${spec.noun}`}>
              <Eye />
              {MENU_WORDS.reveal}
            </WriteMenuItem>
          )
        }
        if (entry === "restart") {
          // Not a WriteMenuItem: the restart asks for the unlock itself, with its purpose.
          return (
            <DropdownMenuItem key={entry} onClick={() => setup.menu(view.id, "restart")} className="h-9">
              <RotateCw />
              Restart {setting.slug}
              {locked && <LockGlyph className="ml-auto" />}
            </DropdownMenuItem>
          )
        }
        return (
          <DropdownMenuItem key={entry} onClick={() => setup.menu(view.id, entry)} className="h-9">
            {MENU_WORDS[entry]}
          </DropdownMenuItem>
        )
      })}
      {view.menu.includes("remove") && (
        <>
          {rest.length > 0 && <DropdownMenuSeparator />}
          <WriteMenuItem variant="destructive" onPress={() => setup.menu(view.id, "remove")} purpose={`remove the ${spec.noun}`}>
            {MENU_WORDS.remove}
          </WriteMenuItem>
        </>
      )}
    </RowMenu>
  )
}

/** The row's one action: open its guide, change a password, or go where the reason is. */
function RowButton({ view, name }: { view: RowView; name: string }) {
  const setup = useServerSetup()
  const actions = useSecretsActions()
  const action = view.action
  if (action === null) return null
  const size = "max-md:h-9"
  if (action.kind === "secrets") {
    return (
      <InternalLink href={siteUrl(action.slug, "secrets")} className={cn(buttonVariants({ variant: "outline", size: "sm" }), size)}>
        {action.label}
      </InternalLink>
    )
  }
  if (action.kind === "password") {
    const which = view.id === "dashboard-password" ? "dashboard-password" : "portal-password"
    return (
      <Button variant="outline" size="sm" onClick={() => setup.changePassword(which)} aria-label={`Change the ${rowSpec(view.id).noun}`} className={size}>
        Change password
        {!actions.state.open && <LockGlyph />}
      </Button>
    )
  }
  const id = view.id
  if (id !== "heartbeat" && id !== "webhook" && id !== "offsite" && id !== "company-signin") return null
  return (
    <Button
      variant={action.primary ? "default" : "outline"}
      size="sm"
      onClick={() => setup.openGuide(id, action.start)}
      aria-label={`${action.label} (${name})`}
      className={size}
    >
      {action.label}
    </Button>
  )
}

/** The state on the right: its word in its tone, Delivered with its check, and a muted line under it. */
function RowState({ view }: { view: RowView }) {
  if (view.word === "") return null
  return (
    <span
      title={view.tip ?? undefined}
      tabIndex={view.tip === null ? undefined : 0}
      className={cn(
        "min-w-0 rounded-sm text-[0.8125rem] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view.tone === "neutral" ? "text-muted-foreground" : view.tone === "ok" ? "text-ok-text" : TONE_TEXT[view.tone],
      )}
    >
      <span className={cn("inline-flex items-center gap-1", view.tone !== "neutral" && "font-medium")}>
        {view.check && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
        {view.word}
      </span>
      {view.extra !== null && <span className="block text-xs leading-4 text-pretty wrap-anywhere text-muted-foreground">{view.extra}</span>}
      {view.tip !== null && <span className="sr-only">. {view.tip}</span>}
    </span>
  )
}

/** What Reveal shows under its row: each value by its plain label, for thirty seconds, then masked again. */
function RevealedValues({ id }: { id: RowId }) {
  const setup = useServerSetup()
  const shown = setup.revealed
  const error = setup.revealError
  if (error !== null && error.id === id) {
    return <p role="alert" className="pr-4 pb-3 pl-13 text-xs text-destructive">{error.message}</p>
  }
  if (shown === null || shown.id !== id) return null
  return (
    <div role="group" aria-label="Revealed values" className="grid gap-1.5 pr-4 pb-3 pl-13">
      {shown.values.map(({ label, value }) => (
        <div key={label} className="grid min-w-0 gap-0.5 @xl/settings:grid-cols-[8.5rem_minmax(0,1fr)] @xl/settings:items-baseline @xl/settings:gap-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <code className="min-w-0 rounded-md bg-sunk px-2 py-0.5 font-mono text-xs break-all text-foreground shadow-well select-all">{value}</code>
        </div>
      ))}
      <p className="text-xs text-muted-foreground tabular-nums">
        {hideCountdown(shown.at + REVEAL_MS - setup.clock)}.{" "}
        <Button variant="link" onClick={setup.hideReveal} className="h-auto p-0 text-xs">
          Hide now
        </Button>
      </p>
    </div>
  )
}

/**
 * One setting as a row, the same on the Server page and on Sites: its icon
 * (the severity icon when it fails), its name and one plain sentence, its
 * state on the right, one action and the "..." of the rest. 44 px on one
 * line; on the Server page a little taller, the sentence wrapping, and the
 * name over it below 64 rem of the list; below 48 rem, two lines and the
 * action at the right of both.
 */
export function SettingRow({ view, place }: { view: RowView; place: "sites" | "server" }) {
  const spec = rowSpec(view.id)
  const Icon = ROW_ICONS[view.id]
  const server = place === "server"
  const password = view.id === "dashboard-password" || view.id === "portal-password"
  return (
    <div role="listitem" className="border-t border-divider first:border-t-0">
      <div
        className={cn(
          "grid min-h-11 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2 py-2.5 pr-2 pl-4",
          server
            ? "@3xl/settings:min-h-13 @3xl/settings:grid-cols-[1.75rem_minmax(0,1fr)_12.5rem_10.5rem] @3xl/settings:py-1.5"
            : "@3xl/settings:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] @3xl/settings:py-0",
        )}
      >
        <span className="row-span-2 flex self-start pt-0.5 text-muted-foreground @3xl/settings:row-span-1 @3xl/settings:self-center @3xl/settings:pt-0">
          {view.error ? <SeverityIcon severity="error" label /> : <Icon aria-hidden="true" className="size-4" />}
        </span>
        <div
          className={cn(
            "col-start-2 row-start-1 flex min-w-0 flex-col",
            server ? "@5xl/settings:flex-row @5xl/settings:items-baseline @5xl/settings:gap-3" : "@3xl/settings:flex-row @3xl/settings:items-baseline @3xl/settings:gap-3",
          )}
        >
          <span className="shrink-0 font-medium text-strong @3xl/settings:w-34">{spec.name}</span>
          <span className={cn("min-w-0 text-pretty text-muted-foreground", !server && "@3xl/settings:truncate")}>{view.line}</span>
        </div>
        <div className="col-start-2 row-start-2 min-w-0 pt-0.5 empty:hidden @3xl/settings:col-start-3 @3xl/settings:row-start-1 @3xl/settings:pt-0 @3xl/settings:pr-2">
          <RowState view={view} />
        </div>
        <div
          className={cn(
            "flex items-center justify-end gap-1",
            password
              ? "col-span-2 col-start-2 row-start-3 justify-self-start pt-2 @3xl/settings:col-span-1 @3xl/settings:col-start-4 @3xl/settings:row-start-1 @3xl/settings:justify-self-end @3xl/settings:pt-0"
              : "col-start-3 row-span-2 row-start-1 @3xl/settings:col-start-4 @3xl/settings:row-span-1",
          )}
        >
          <RowButton view={view} name={spec.name} />
          {view.menu.length > 0 ? <RowEntries view={view} name={spec.name} /> : <span aria-hidden="true" className="size-8 shrink-0 max-md:size-10" />}
        </div>
      </div>
      {server && <RevealedValues id={view.id} />}
    </div>
  )
}
