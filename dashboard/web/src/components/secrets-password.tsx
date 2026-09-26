import { useEffect, useId, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react"
import { Check, Copy, Eye, EyeOff } from "lucide-react"
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
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, INPUT_DIALOG } from "@/components/page"
import type { FocusReturn, OnRefusal } from "@/components/secrets-dialogs"
import { changePassword } from "@/lib/api"
import { waitMessage } from "@/lib/signin"
import { closeOutcome } from "@/lib/invitations"
import {
  passwordAnnouncement,
  passwordToSend,
  firstFaultyField,
  generatedPasswordText,
  passwordTexts,
  checkEntry,
  type PasswordErrors,
  type PasswordMode,
} from "@/lib/password"
import { refusalOf, succeeded } from "@/lib/secrets"
import { cn } from "@/lib/utils"

/**
 * Changing a password of which the steward only keeps the hash:
 * `PASSWORD_HASH` for the dashboard and for the portal. Never a hash on screen
 * or to paste: the dashboard password retyped, then a password drawn by the
 * steward, shown once, or a chosen password, typed twice.
 */

export type PasswordTarget = { slug: string; file: string; variable: string; opening: number }

const COPY_WARNING = "You haven't copied the password. It can't be shown again."

/** The secret fields: masked, with no suggestion and no memory from the password manager. */
const NO_PASSWORD_MANAGER = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
} as const

export function PasswordDialog({
  target,
  open,
  onClose,
  onChange,
  onRefusal,
  focusReturn,
}: {
  target: PasswordTarget | null
  open: boolean
  onClose: () => void
  /** The password has changed: the file and the log are read again. */
  onChange: () => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  // What the dialog needs to know of its own path to decide on closing, with no extra render.
  const guard = useRef<Guard | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        const current = guard.current
        if (current === null) return onClose()
        if (!current.inProgress) current.ask()
      }}
    >
      <DialogContent finalFocus={focusReturn} className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)}>
        {target !== null && (
          <PasswordFlow
            key={target.opening}
            target={target}
            onClose={onClose}
            onChange={onChange}
            onRefusal={onRefusal}
            guard={guard}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

type Guard = { inProgress: boolean; ask: () => void }

type Step = { phase: "entry" } | { phase: "generated"; password: string } | { phase: "selected" }

function PasswordFlow({
  target,
  onClose,
  onChange,
  onRefusal,
  guard,
}: {
  target: PasswordTarget
  onClose: () => void
  onChange: () => void
  onRefusal: OnRefusal
  guard: RefObject<Guard | null>
}) {
  const announce = useAnnounce()
  const texts = passwordTexts(target.slug, target.variable)
  const [step, setStep] = useState<Step>({ phase: "entry" })
  const [inProgress, setEnCours] = useState(false)
  const [copyState, setCopied] = useState(false)
  const [warned, setWarned] = useState(false)

  // Closing the drawn password screen without having copied it takes two gestures, as for a guest.
  function askToClose() {
    if (inProgress) return
    if (step.phase !== "generated" || closeOutcome(copyState, warned) === "closeButton") return onClose()
    setWarned(true)
    announce(COPY_WARNING)
  }

  useEffect(() => {
    guard.current = { inProgress, ask: askToClose }
  })
  useEffect(
    () => () => {
      guard.current = null
    },
    [guard],
  )

  function change(password: string | null) {
    onChange()
    announce(passwordAnnouncement(password !== null))
    setStep(password === null ? { phase: "selected" } : { phase: "generated", password })
  }

  if (step.phase === "generated") {
    return (
      <GeneratedPasswordScreen
        title={texts.generatedTitle}
        nextStep={texts.nextStep}
        password={step.password}
        warned={warned && !copyState}
        onCopied={() => setCopied(true)}
        onDone={askToClose}
      />
    )
  }

  if (step.phase === "selected") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Password changed</DialogTitle>
          <DialogDescription className="text-pretty">{texts.nextStep}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button autoFocus className="max-sm:h-11" />}>Close</DialogClose>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">{texts.title}</DialogTitle>
        <DialogDescription className="text-pretty">
          Only a hash of the new password is kept, in <span className="font-mono">{target.file}</span>. Nobody can
          read it back, you included.
        </DialogDescription>
      </DialogHeader>
      <Banner tone="attention">{texts.warning}</Banner>
      <PasswordForm
        target={target}
        inProgress={inProgress}
        setEnCours={setEnCours}
        onChange={change}
        onRefusal={onRefusal}
      />
    </>
  )
}

/** A form field: label, control, help, error under the field. */
function Field({
  id,
  labelText,
  help,
  error,
  children,
}: {
  id: string
  labelText: string
  help?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{labelText}</Label>
      {children}
      {error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-xs text-pretty text-muted-foreground">
            {help}
          </p>
        )
      )}
    </div>
  )
}

const describedBy = (id: string, error: string | undefined, help: boolean) =>
  error !== undefined ? `${id}-error` : help ? `${id}-help` : undefined

function PasswordForm({
  target,
  inProgress,
  setEnCours,
  onChange,
  onRefusal,
}: {
  target: PasswordTarget
  inProgress: boolean
  setEnCours: (inProgress: boolean) => void
  onChange: (password: string | null) => void
  onRefusal: OnRefusal
}) {
  const [dashboard, setDashboardPassword] = useState("")
  const [mode, setMode] = useState<PasswordMode>("draw")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [visible, setVisible] = useState(false)
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [formError, setFormError] = useState("")
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  const fields = {
    dashboard: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    confirmation: useRef<HTMLInputElement>(null),
  }
  const dashboardPasswordId = useId()
  const idMode = useId()
  const newPasswordId = useId()
  const idConfirmation = useId()

  const restantS = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - clock) / 1000))

  // The rate limit countdown, second by second, as on the unlock.
  useEffect(() => {
    if (waitUntil === null) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  useEffect(() => {
    if (waitUntil === null || restantS > 0) return
    setWaitUntil(null)
    setErrors(({ dashboard: _, ...remaining }) => remaining)
  }, [waitUntil, restantS])

  async function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress || restantS > 0) return
    const faults = checkEntry({ dashboard, mode, newPassword, confirmation })
    setErrors(faults)
    setFormError("")
    const first = firstFaultyField(faults)
    if (first !== null) return fields[first].current?.focus()

    setEnCours(true)
    try {
      const { status, body } = await changePassword({
        slug: target.slug,
        file: target.file,
        variable: target.variable,
        dashboardPassword: dashboard,
        newPassword: passwordToSend({ mode, newPassword }),
      })
      if (succeeded(status) && body !== null) {
        const generated = typeof body.password === "string" ? body.password : null
        setDashboardPassword("")
        setNewPassword("")
        setConfirmation("")
        return onChange(generated)
      }
      const refusal = refusalOf(status, body)
      const message = onRefusal(refusal)
      if (message === null) return
      // A 401 that did not bring the session down: the dashboard password is refused.
      if (refusal.kind === "rejects" && (status === 401 || status === 429)) {
        if (refusal.waitS > 0) {
          const start = Date.now()
          setClock(start)
          setWaitUntil(start + refusal.waitS * 1000)
        }
        setDashboardPassword("")
        setErrors({ dashboard: message })
        return fields.dashboard.current?.focus()
      }
      setFormError(message)
    } finally {
      setEnCours(false)
    }
  }

  const label = inProgress ? "Changing…" : restantS > 0 ? waitMessage(restantS) : "Change password"
  const fieldType = visible ? "text" : "password"

  return (
    <form noValidate onSubmit={submit} className="grid gap-5">
      {/* The same username as the sign-in: the password manager offers the dashboard's. */}
      <input type="text" name="username" autoComplete="username" value="sitesolide" readOnly hidden />
      <Field
        id={dashboardPasswordId}
        labelText="Dashboard password"
        help="Entered again to confirm it's you."
        error={errors.dashboard}
      >
        <Input
          ref={fields.dashboard}
          id={dashboardPasswordId}
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={dashboard}
          onChange={(event) => {
            setDashboardPassword(event.target.value)
            if (restantS === 0) setErrors(({ dashboard: _, ...remaining }) => remaining)
          }}
          aria-invalid={errors.dashboard !== undefined || undefined}
          aria-describedby={describedBy(dashboardPasswordId, errors.dashboard, true)}
          className="h-10 sm:h-9"
        />
      </Field>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm leading-none font-medium">New password</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["draw", "Generate a strong one"],
              ["choose", "Set my own"],
            ] as const
          ).map(([value, text]) => (
            <label
              key={value}
              className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-input px-2 text-center text-sm transition-colors select-none hover:bg-muted has-checked:border-foreground has-checked:bg-muted has-checked:font-medium has-checked:ring-1 has-checked:ring-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:h-9"
            >
              <input
                type="radio"
                name={idMode}
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value)
                  setErrors(({ dashboard }) => (dashboard === undefined ? {} : { dashboard }))
                }}
                className="sr-only"
              />
              {text}
            </label>
          ))}
        </div>
        <p className="text-xs text-pretty text-muted-foreground">
          {mode === "draw"
            ? "The steward draws a long random password and shows it to you once."
            : "Type it twice. The steward says if it is too weak."}
        </p>
      </fieldset>

      {mode === "choose" && (
        <div className="grid gap-4">
          <Field id={newPasswordId} labelText="New password" error={errors.newPassword}>
            <div className="relative">
              <Input
                ref={fields.newPassword}
                id={newPasswordId}
                type={fieldType}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                spellCheck={false}
                {...NO_PASSWORD_MANAGER}
                aria-invalid={errors.newPassword !== undefined || undefined}
                aria-describedby={describedBy(newPasswordId, errors.newPassword, false)}
                className="h-10 pr-11 font-mono sm:h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={visible ? "Hide passwords" : "Show passwords"}
                onClick={() => setVisible((before) => !before)}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground max-sm:size-8"
              >
                {visible ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>
          <Field id={idConfirmation} labelText="Repeat new password" error={errors.confirmation}>
            <Input
              ref={fields.confirmation}
              id={idConfirmation}
              type={fieldType}
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value)
                setErrors(({ confirmation: _, ...remaining }) => remaining)
              }}
              spellCheck={false}
              {...NO_PASSWORD_MANAGER}
              aria-invalid={errors.confirmation !== undefined || undefined}
              aria-describedby={describedBy(idConfirmation, errors.confirmation, false)}
              className="h-10 font-mono sm:h-9"
            />
          </Field>
        </div>
      )}

      {formError !== "" && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

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

/**
 * The drawn password, shown only once, with its copy button. No live region
 * here: a screen reader would read it out loud. The announcements go through
 * the shared region, without it.
 */
function GeneratedPasswordScreen({
  title,
  nextStep,
  password,
  warned,
  onCopied,
  onDone,
}: {
  title: string
  nextStep: string
  password: string
  warned: boolean
  onCopied: () => void
  onDone: () => void
}) {
  const copyState = useCopy("Password copied")
  const button = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLElement>(null)
  const text = generatedPasswordText(password)

  // The form has just disappeared along with focus: the next gesture is the copy.
  useEffect(() => {
    button.current?.focus()
  }, [])

  async function copy() {
    if (await copyState.copy(text)) return onCopied()
    if (code.current !== null) window.getSelection()?.selectAllChildren(code.current)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">{title}</DialogTitle>
        <DialogDescription className="text-pretty">
          Copy it now and keep it in your password manager. It is shown only once: only its hash is kept.
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3">
        <code ref={code} className="min-w-0 font-mono text-base font-semibold tracking-wide select-all wrap-anywhere">
          {password}
        </code>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={copyState.state === "copied" ? "Password copied" : "Copy password"}
          title="Copy password"
          onClick={() => void copy()}
          className="shrink-0 text-muted-foreground hover:text-foreground max-sm:size-11"
        >
          {copyState.state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
        </Button>
      </div>

      {copyState.state === "failure" && <CopyFallback text={text} onClose={copyState.reset} />}

      <p className="text-sm text-pretty text-muted-foreground">{nextStep}</p>

      {warned && <Banner tone="attention">{COPY_WARNING}</Banner>}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} className="max-sm:h-11">
          {warned ? "Close without copying" : "Done"}
        </Button>
        <Button ref={button} onClick={() => void copy()} className="max-sm:h-11">
          {copyState.state === "copied" ? <Check /> : <Copy />}
          {copyState.state === "copied" ? "Copied" : "Copy password"}
        </Button>
      </DialogFooter>
    </>
  )
}
