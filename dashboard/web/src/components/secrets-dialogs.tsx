import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { CircleCheck, CircleX, Dices, Eye, EyeOff, LoaderCircle } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { useAnnounce } from "@/components/copy"
import { INPUT_DIALOG, Status } from "@/components/page"
import { unlockSecrets, setVariable } from "@/lib/api"
import { waitMessage } from "@/lib/signin"
import { restartProgress, generateToken, refusalOf, readVerdict, succeeded, type Refusal } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { FileView, RestartVerdict } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * What the page does with a refusal: it handles the lost session, the lock and
 * the unreachable steward itself, and returns the message to show under the
 * field, or null when there is nothing left to show here.
 */
export type OnRefusal = (refusal: Refusal) => string | null

/** Where to return focus on closing: an element, the default behaviour, or nowhere. */
export type FocusReturn = () => HTMLElement | boolean

// --- Unlocking -----------------------------------------------------------------

/**
 * The dashboard password, typed a second time and checked by the steward, not
 * by the service. The field lives inside the dialog, which unmounts on closing:
 * the password does not outlive its display. The rate limit countdown, for its
 * part, stays at the dialog's level, so that reopening does not clear it.
 */
export function UnlockDialog({
  open,
  onClose,
  onUnlocked,
  onRefusal,
  focusReturn,
}: {
  open: boolean
  onClose: () => void
  onUnlocked: (until: number) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [inProgress, setEnCours] = useState(false)
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const field = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <DialogContent initialFocus={field} finalFocus={focusReturn} className={cn("sm:max-w-md", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle>Unlock secrets</DialogTitle>
          <DialogDescription>
            Enter the dashboard password again to show, copy and change values. Secrets lock again on their own after a
            few minutes.
          </DialogDescription>
        </DialogHeader>
        <UnlockForm
          field={field}
          inProgress={inProgress}
          setEnCours={setEnCours}
          waitUntil={waitUntil}
          setWaitUntil={setWaitUntil}
          onUnlocked={onUnlocked}
          onRefusal={onRefusal}
        />
      </DialogContent>
    </Dialog>
  )
}

function UnlockForm({
  field,
  inProgress,
  setEnCours,
  waitUntil,
  setWaitUntil,
  onUnlocked,
  onRefusal,
}: {
  field: React.RefObject<HTMLInputElement | null>
  inProgress: boolean
  setEnCours: (inProgress: boolean) => void
  waitUntil: number | null
  setWaitUntil: (finish: number | null) => void
  onUnlocked: (until: number) => void
  onRefusal: OnRefusal
}) {
  const fieldId = useId()
  const errorId = useId()
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState("")
  const [clock, setClock] = useState(() => Date.now())

  const restantS = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - clock) / 1000))

  // The rate limit countdown, second by second, down to zero, as on the sign-in.
  useEffect(() => {
    if (waitUntil === null) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  useEffect(() => {
    if (waitUntil === null || restantS > 0) return
    setWaitUntil(null)
    setError("")
  }, [waitUntil, restantS, setWaitUntil])

  async function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress || restantS > 0) return
    if (password === "") {
      setError("Enter the password.")
      return field.current?.focus()
    }
    setEnCours(true)
    setError("")
    try {
      const { status, body } = await unlockSecrets(password)
      if (succeeded(status) && body !== null && typeof body.until === "number") {
        setPassword("")
        return onUnlocked(body.until)
      }
      const refusal = refusalOf(status, body)
      const message = onRefusal(refusal)
      if (message === null) return
      if (refusal.kind === "rejects" && refusal.waitS > 0) {
        const start = Date.now()
        setClock(start)
        setWaitUntil(start + refusal.waitS * 1000)
      }
      if (refusal.kind === "rejects") setPassword("")
      setError(message)
      field.current?.focus()
    } finally {
      setEnCours(false)
    }
  }

  const label = inProgress ? "Unlocking…" : restantS > 0 ? waitMessage(restantS) : "Unlock"

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      {/* The same username as the sign-in: the password manager offers the same secret. */}
      <input type="text" name="username" autoComplete="username" value="sitesolide" readOnly hidden />
      <div className="grid gap-2">
        <Label htmlFor={fieldId}>Dashboard password</Label>
        <div className="relative">
          <Input
            ref={field}
            id={fieldId}
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error !== "" || undefined}
            aria-describedby={error !== "" ? errorId : undefined}
            className="h-10 pr-11 sm:h-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={() => setVisible((before) => !before)}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground max-sm:size-8"
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        {error !== "" && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" className="max-sm:h-11" />} disabled={inProgress}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={inProgress || restantS > 0} className="tabular-nums max-sm:h-11">
          {label}
        </Button>
      </DialogFooter>
    </form>
  )
}

// --- Adding or editing a variable ----------------------------------------------

export type EditTarget = {
  slug: string
  file: string
  /** null for an addition. */
  variable: string | null
  /** Changes on every opening: the form starts over, even reopened during the closing animation. */
  opening: number
}

/**
 * The name and the value, sent as they are: the page judges neither of them,
 * the steward does and its refusal is shown under the field. The value is never
 * preloaded: reading it would be a logged read, and changing a key means typing
 * another one.
 */
export function VariableDialog({
  target,
  open,
  onClose,
  onSaved,
  onRefusal,
  focusReturn,
}: {
  target: EditTarget | null
  open: boolean
  onClose: () => void
  onSaved: (target: EditTarget, variable: string, restart: boolean) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [inProgress, setEnCours] = useState<"save" | "restart" | null>(null)
  const editing = target?.variable !== null && target?.variable !== undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && inProgress === null) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} className={cn("sm:max-w-lg", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug wrap-anywhere">
            {editing ? (
              <>
                Change <span className="font-mono">{target?.variable}</span>
              </>
            ) : (
              <>
                Add a variable to <span className="font-mono">{target?.file}</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {editing ? (
              <>
                In <span className="font-mono">{target?.file}</span>. {target?.slug} keeps its current value until it
                restarts.
              </>
            ) : (
              <>{target?.slug} reads it the next time it starts.</>
            )}
          </DialogDescription>
        </DialogHeader>
        {target !== null && (
          <VariableForm
            key={target.opening}
            target={target}
            inProgress={inProgress}
            setEnCours={setEnCours}
            onSaved={onSaved}
            onRefusal={onRefusal}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function VariableForm({
  target,
  inProgress,
  setEnCours,
  onSaved,
  onRefusal,
}: {
  target: EditTarget
  inProgress: "save" | "restart" | null
  setEnCours: (inProgress: "save" | "restart" | null) => void
  onSaved: (target: EditTarget, variable: string, restart: boolean) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const editing = target.variable !== null
  const [name, setName] = useState(target.variable ?? "")
  const [value, setValue] = useState("")
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState("")
  const valueField = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const valueId = useId()
  const helpId = useId()
  const errorId = useId()

  async function save(restart: boolean) {
    if (inProgress !== null) return
    setEnCours(restart ? "restart" : "save")
    setError("")
    try {
      const { status, body } = await setVariable({ slug: target.slug, file: target.file, variable: name, value })
      if (succeeded(status)) {
        setValue("")
        return onSaved(target, name, restart)
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setError(message)
    } finally {
      setEnCours(null)
    }
  }

  function generate() {
    setValue(generateToken())
    setError("")
    announce("Random value generated")
    valueField.current?.focus()
  }

  const describedBy = (...ids: (string | false)[]) => ids.filter((id): id is string => id !== false).join(" ") || undefined
  const busy = inProgress !== null

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
      className="grid gap-4"
    >
      {!editing && (
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={describedBy(error !== "" && errorId)}
            className="h-10 font-mono sm:h-9"
          />
        </div>
      )}

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={valueId}>{editing ? "New value" : "Value"}</Label>
          <Button type="button" variant="ghost" size="sm" onClick={generate} disabled={busy} className="-mr-2 max-sm:h-9">
            <Dices />
            Generate
          </Button>
        </div>
        <div className="relative">
          <Input
            ref={valueField}
            id={valueId}
            type={visible ? "text" : "password"}
            value={value}
            autoFocus={editing}
            onChange={(event) => setValue(event.target.value)}
            // A secret value is not a browser password: nothing to suggest, nothing to remember.
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            spellCheck={false}
            // When editing, the name is fixed: a refusal can only concern the value. On an addition, the page
            // does not know which of the two fields the steward refuses, so it marks neither.
            aria-invalid={(editing && error !== "") || undefined}
            aria-describedby={describedBy(helpId, error !== "" && errorId)}
            className="h-10 pr-11 font-mono sm:h-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={visible ? "Hide value" : "Show value"}
            onClick={() => setVisible((before) => !before)}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground max-sm:size-8"
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <p id={helpId} className="text-xs text-pretty text-muted-foreground">
          Generate makes a random 256-bit token, for a secret the site issues itself.
        </p>
        {error !== "" && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" className="max-sm:h-11" />} disabled={busy}>
          Cancel
        </DialogClose>
        <Button type="submit" variant="outline" disabled={busy} className="max-sm:h-11">
          {inProgress === "save" ? "Saving…" : "Save"}
        </Button>
        <Button type="button" disabled={busy} onClick={() => void save(true)} className="max-sm:h-11">
          {inProgress === "restart" ? "Saving…" : "Save & restart"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// --- Confirming ----------------------------------------------------------------

/** A confirmation before an action that writes: removing a variable, restoring a file. */
export function ConfirmDialog({
  open,
  title,
  description,
  action,
  actionEnCours,
  destructive = false,
  inProgress,
  error,
  onConfirm,
  onClose,
  focusReturn,
}: {
  open: boolean
  title: React.ReactNode
  description: React.ReactNode
  action: string
  actionEnCours: string
  destructive?: boolean
  inProgress: boolean
  error: string
  onConfirm: () => void
  onClose: () => void
  focusReturn: FocusReturn
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <AlertDialogContent finalFocus={focusReturn} className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== "" && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={inProgress} className="max-sm:h-11">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={inProgress}
            onClick={onConfirm}
            className="max-sm:h-11"
          >
            {inProgress ? actionEnCours : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// --- Restarting ----------------------------------------------------------------

export type RestartState = {
  slug: string
  open: boolean
  phase: "confirmation" | "in-progress" | "verdict" | "error"
  /** The browser time at which the wait started, for the track. */
  start: number | null
  verdict: RestartVerdict | null
  /** The refusal of a restart, or of a restore asked for from the verdict. */
  message: string
  /** The file being restored, from the verdict. */
  restoration: string | null
  /** The file restored just before this restart: the verdict says so, and does not offer to go back. */
  restored: string | null
  /**
   * The restart of the dashboard itself: `wait` during the cut, `back`
   * once it answers again. null for any other service.
   */
  reconnect: "waiting" | "back" | null
}

/** A wait's clock, second by second, for as long as the dialog is mounted. */
function useClock(): number {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return clock
}

/**
 * A waiting track: the time actually elapsed on its scale, with the usual
 * duration engraved on it when it is known, like the thresholds on the
 * machine's gauges. The page does not know where the server has got to, and
 * does not pretend to.
 */
export function Track({
  part,
  elapsed,
  usual,
  finish,
  label,
}: {
  part: number
  elapsed: string
  /** Where the usual duration sits on the track, between 0 and 1, or null if it is not known. */
  usual: number | null
  /** The label at the end of the track, "1 min". */
  finish: string
  label: string
}) {
  const position = usual === null ? null : { left: `${usual * 100}%` }
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-display text-base font-semibold tabular-nums">{elapsed}</span>
      </div>
      <div className="relative pb-5">
        <Progress
          value={part * 100}
          aria-label="Time waited"
          getAriaValueText={() => `${elapsed} waited`}
          className="w-full [&_[data-slot=progress-indicator]]:bg-foreground/55 [&_[data-slot=progress-indicator]]:transition-[width] [&_[data-slot=progress-indicator]]:duration-1000 [&_[data-slot=progress-indicator]]:ease-linear motion-reduce:[&_[data-slot=progress-indicator]]:transition-none [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-foreground/10"
        />
        {position !== null && (
          <>
            <span aria-hidden="true" className="pointer-events-none absolute top-0 h-2 w-0.5 -translate-x-1/2 bg-popover" style={position} />
            <span aria-hidden="true" className="pointer-events-none absolute top-2.5 h-1.5 w-px -translate-x-1/2 bg-foreground/35" style={position} />
            <span aria-hidden="true" className="absolute bottom-0 -translate-x-1/2 text-xs text-muted-foreground" style={position}>
              usual
            </span>
          </>
        )}
        <span aria-hidden="true" className="absolute right-0 bottom-0 text-xs text-muted-foreground">
          {finish}
        </span>
      </div>
    </div>
  )
}

/** The wait for a restart's verdict, over one minute with the usual duration engraved. */
function WaitTrack({ start }: { start: number }) {
  const clock = useClock()
  const { part, usual, elapsed, slow } = restartProgress(clock - start)
  return (
    <div className="grid gap-2">
      <Track
        part={part}
        elapsed={elapsed}
        usual={usual}
        finish="1 min"
        label={slow ? "Taking longer than usual" : "Waiting for the verdict"}
      />
      <p className="text-xs text-pretty text-muted-foreground">
        {slow
          ? "Some services take longer to settle. Keep this open: the verdict comes within a minute."
          : "Usually about ten seconds. Keep this open to see whether it stays up."}
      </p>
    </div>
  )
}

/**
 * The dashboard is restarting: the page waits for it to answer again, with
 * nothing to say about it but the time elapsed. Nothing here stops you closing.
 */
function Reconnect({ phase, start }: { phase: "waiting" | "back"; start: number | null }) {
  const clock = useClock()
  if (phase === "back") {
    return (
      <p role="status" className="flex items-start gap-2 text-sm text-pretty">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ok-text" />
        <span>
          <span className="font-medium">The dashboard is back.</span> Unlock again to keep changing secrets.
        </span>
      </p>
    )
  }
  const elapsed = start === null ? null : Math.max(0, Math.floor((clock - start) / 1000))
  return (
    <p className="flex items-start gap-2 text-sm text-pretty text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
      <span>
        Waiting for the dashboard to come back
        {elapsed !== null && <span className="tabular-nums">, {elapsed}s</span>}. The page keeps trying on its own.
      </span>
    </p>
  )
}

/**
 * A service's restart, in three stages: the cut announced, the wait for the
 * verdict, then the verdict in plain words. On a crash loop or a failure, the
 * previous version is offered, never on its own initiative: it may be the key
 * that leaked.
 */
export function RestartDialog({
  state,
  pending,
  restorable,
  onConfirm,
  onRestore,
  onClose,
  focusReturn,
}: {
  state: RestartState | null
  /** The files changed since the last startup, which this restart will apply. */
  pending: string[]
  restorable: FileView[]
  onConfirm: (slug: string) => void
  onRestore: (slug: string, file: string) => void
  onClose: () => void
  focusReturn: FocusReturn
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const phase = state?.phase ?? "confirmation"
  const slug = state?.slug ?? ""
  const busy = phase === "in-progress" || (state?.restoration ?? null) !== null

  // The verdict arrives in an already open dialog, whose clicked button has gone: focus goes to "Close".
  useEffect(() => {
    if (phase === "verdict" || phase === "error") closeButton.current?.focus()
  }, [phase])

  const verdictText = state?.verdict ? readVerdict(state.verdict, slug) : null
  const restored = state?.restored ?? null
  const reconnect = state?.reconnect ?? null
  // After a restore, the page does not offer another one: that would be tossing a coin between two keys.
  const offerRestore = verdictText !== null && verdictText.restore && restored === null
  const VerdictIcon = verdictText?.tone === "ok" ? CircleCheck : CircleX

  return (
    <AlertDialog
      open={state?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <AlertDialogContent finalFocus={focusReturn} aria-busy={busy || undefined} className="sm:max-w-md">
        {(phase === "confirmation" || phase === "in-progress") && (
          <>
            <AlertDialogHeader className="text-left max-sm:place-items-start">
              <AlertDialogTitle>{phase === "in-progress" ? `Restarting ${slug}…` : `Restart ${slug}?`}</AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">
                {slug} stops, then starts again with its secret files as they are now. Requests to it fail for a few
                seconds in between.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {phase === "confirmation" && pending.length > 0 && (
              <p className="text-sm text-pretty">
                Applies the changes to{" "}
                {pending.map((name, index) => (
                  <span key={name}>
                    {index > 0 && ", "}
                    <span className="font-mono">{name}</span>
                  </span>
                ))}
                .
              </p>
            )}
            {phase === "confirmation" && (
              <p className="text-sm text-pretty text-muted-foreground">
                The page then tells you whether it stayed up, usually within ten seconds and always within a minute.
              </p>
            )}
            {phase === "in-progress" && state?.start != null && <WaitTrack start={state.start} />}
            <AlertDialogFooter>
              {/* A restart already under way cannot be cancelled: the button would only lie. */}
              {phase === "confirmation" && (
                <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
              )}
              <AlertDialogAction disabled={busy} onClick={() => onConfirm(slug)} className="max-sm:h-11">
                {phase === "in-progress" ? "Restarting…" : "Restart service"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {phase === "verdict" && verdictText !== null && (
          <>
            <AlertDialogHeader className="text-left max-sm:place-items-start">
              <AlertDialogTitle className="flex items-center gap-2">
                {reconnect === null ? (
                  <VerdictIcon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[verdictText.tone])} />
                ) : null}
                {verdictText.title}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">{verdictText.detail}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Status tone={verdictText.tone} shape="pill">
                {verdictText.word}
              </Status>
            </div>
            {reconnect !== null && <Reconnect phase={reconnect} start={state?.start ?? null} />}
            {restored !== null && (
              <p className="text-sm text-pretty text-muted-foreground">
                This restart came right after restoring the previous <span className="font-mono">{restored}</span>.
                {verdictText.restore && " It still fails: check its logs on the server before changing anything else."}
              </p>
            )}
            {offerRestore && restorable.length === 0 && (
              <p className="text-sm text-muted-foreground">No previous version of its secret files is kept.</p>
            )}
            {offerRestore && restorable.length > 0 && (
              <p className="text-sm text-pretty text-muted-foreground">
                Restoring puts the file back as it was before its last change, then restarts {slug}. That version may
                hold a key you meant to retire.
              </p>
            )}
            {state?.message ? (
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel ref={closeButton} disabled={busy} className="max-sm:h-11">
                Close
              </AlertDialogCancel>
              {offerRestore &&
                restorable.map((file) => (
                  <Button
                    key={file.name}
                    disabled={busy}
                    onClick={() => onRestore(slug, file.name)}
                    className="h-auto min-h-8 whitespace-normal max-sm:min-h-11"
                  >
                    {state?.restoration === file.name
                      ? "Restoring…"
                      : restorable.length === 1
                        ? "Restore previous & restart"
                        : `Restore previous ${file.name} & restart`}
                  </Button>
                ))}
            </AlertDialogFooter>
          </>
        )}

        {phase === "error" && (
          <>
            <AlertDialogHeader className="text-left max-sm:place-items-start">
              <AlertDialogTitle>Couldn't restart {slug}</AlertDialogTitle>
              <AlertDialogDescription>{state?.message}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel ref={closeButton} className="max-sm:h-11">
                Close
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => onConfirm(slug)} className="max-sm:h-11">
                Retry
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
