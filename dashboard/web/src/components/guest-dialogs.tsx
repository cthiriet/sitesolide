import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { Check, ChevronDown, Copy } from "lucide-react"
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
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { useData } from "@/components/data"
import { Banner, INPUT_DIALOG } from "@/components/page"
import { createGuest } from "@/lib/api"
import { guestDuration } from "@/lib/format"
import {
  endDate,
  deadline,
  plannedEnd,
  initialHost,
  closeOutcome,
  firstField,
  guestRefusal,
  invitationText,
  validateInvitation,
  type Field as FieldName,
  type FieldErrors,
} from "@/lib/invitations"
import { DEFAULT_GUEST_DURATION_S, GUEST_DURATIONS, LABEL_MAX, type Guest } from "@/lib/guests"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The two guest access dialogs, shared by the Guests page and a site's card:
 * the creation, up to the password screen, and the confirmation of a
 * revocation.
 */

/** The value of a duration choice is a string: "no expiry" needs a name. */
const NONE = "none"
const toChoice = (seconds: number | null) => (seconds === null ? NONE : String(seconds))
const fromChoice = (choice: string) => (choice === NONE ? null : Number(choice))

type Created = { guest: Guest; password: string }

const COPY_WARNING = "You haven't copied the password. It can't be shown again."

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
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )
      )}
    </div>
  )
}

/**
 * The creation form. Mounted on every opening, through the key
 * `useGuestActions` gives it: nothing from a previous creation, and above all
 * not its password, can reappear in the next one.
 *
 * Closing the password screen without having copied it takes two gestures,
 * whichever gesture it is: Done, the cross, Escape or a click outside. The
 * first warns, the second closes.
 */
export function CreateGuestDialog({
  open,
  requestedHost,
  sites,
  onClose,
  focusReturn,
}: {
  open: boolean
  /** The site already chosen, from a site's card. */
  requestedHost: string | null
  /** Only the sites that can take guests. */
  sites: readonly Pick<Site, "slug" | "address">[]
  onClose: () => void
  focusReturn: () => HTMLElement | boolean
}) {
  const { guests, now, sessionExpired } = useData()
  const announce = useAnnounce()
  const hosts = sites.map((site) => site.address)

  const [host, setHost] = useState(() => initialHost(hosts, requestedHost))
  const [label, setLabel] = useState("")
  const [choice, setChoice] = useState(toChoice(DEFAULT_GUEST_DURATION_S))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setEnCours] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)
  const [warned, setWarned] = useState(false)

  const siteField = useRef<HTMLSelectElement>(null)
  const labelField = useRef<HTMLInputElement>(null)
  const durationField = useRef<HTMLInputElement>(null)

  const idSite = useId()
  const labelId = useId()
  const durationId = useId()

  function focusField(field: FieldName) {
    const targets = { site: siteField, label: labelField, duration: durationField }
    targets[field].current?.focus()
  }

  function askToClose() {
    if (inProgress) return
    if (created === null || closeOutcome(copied, warned) === "closeButton") return onClose()
    setWarned(true)
    announce(COPY_WARNING)
  }

  async function create(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return

    const faults = validateInvitation(host, label, hosts)
    setErrors(faults)
    setFormError("")
    const first = firstField(faults)
    if (first !== null) return focusField(first)

    setEnCours(true)
    try {
      const { status, body } = await createGuest(host, label, fromChoice(choice))
      if (status === 401) {
        // The dialog lives outside the page made inert: it closes under the sign-in.
        onClose()
        return sessionExpired()
      }
      if (status !== 201 || body === null || typeof body.password !== "string") {
        const refusal = guestRefusal(status, body)
        if (refusal.field === null) return setFormError(refusal.message)
        setErrors({ [refusal.field]: refusal.message })
        return focusField(refusal.field)
      }
      setCreated({ guest: body.guest, password: body.password })
      announce(
        `Access created for ${body.guest.label} on ${body.guest.host}. Copy the password now: it won't be shown again.`,
      )
      void guests.reload()
    } finally {
      setEnCours(false)
    }
  }

  const siteHelp = host === "" ? "Only sites behind the portal are listed." : `They sign in at ${host}.`
  const describedby = (id: string, error: string | undefined) => (error !== undefined ? `${id}-error` : `${id}-help`)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) askToClose()
      }}
    >
      <DialogContent
        className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)}
        finalFocus={focusReturn}
        initialFocus={() => (host === "" ? siteField.current : labelField.current)}
      >
        {created === null ? (
          <form noValidate onSubmit={create} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Create access</DialogTitle>
              <DialogDescription className="text-pretty">
                A password for one person on one site. You can revoke it at any time.
              </DialogDescription>
            </DialogHeader>

            <Field id={idSite} labelText="Site" error={errors.site} help={siteHelp}>
              <div className="relative">
                <select
                  ref={siteField}
                  id={idSite}
                  value={host}
                  onChange={(event) => {
                    setHost(event.target.value)
                    setErrors(({ site: _, ...remaining }) => remaining)
                  }}
                  aria-invalid={errors.site !== undefined || undefined}
                  aria-describedby={describedby(idSite, errors.site)}
                  className={cn(
                    "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent pr-9 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-9 sm:text-sm dark:bg-input/30",
                    host === "" && "text-muted-foreground",
                  )}
                >
                  <option value="" disabled>
                    Choose a site
                  </option>
                  {sites.map((site) => (
                    <option key={site.address} value={site.address} className="text-foreground">
                      {site.slug}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </Field>

            <Field id={labelId} labelText="Guest name" error={errors.label} help="Only you see this name.">
              <Input
                ref={labelField}
                id={labelId}
                value={label}
                maxLength={LABEL_MAX}
                autoComplete="off"
                onChange={(event) => {
                  setLabel(event.target.value)
                  setErrors(({ label: _, ...remaining }) => remaining)
                }}
                aria-invalid={errors.label !== undefined || undefined}
                aria-describedby={describedby(labelId, errors.label)}
                className="h-10 sm:h-9"
              />
            </Field>

            <fieldset
              className="grid gap-2"
              aria-describedby={describedby(durationId, errors.duration)}
              aria-invalid={errors.duration !== undefined || undefined}
            >
              <legend className="mb-2 text-sm leading-none font-medium">Duration</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {GUEST_DURATIONS.map((option, index) => {
                  const value = toChoice(option.seconds)
                  return (
                    <label
                      key={value}
                      className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-input px-2 text-sm whitespace-nowrap transition-colors select-none hover:bg-muted has-checked:border-foreground has-checked:bg-muted has-checked:font-medium has-checked:ring-1 has-checked:ring-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:h-9"
                    >
                      <input
                        ref={index === 0 ? durationField : undefined}
                        type="radio"
                        name={durationId}
                        value={value}
                        checked={choice === value}
                        onChange={() => {
                          setChoice(value)
                          setErrors(({ duration: _, ...remaining }) => remaining)
                        }}
                        className="sr-only"
                      />
                      {guestDuration(option.seconds)}
                    </label>
                  )
                })}
              </div>
              {errors.duration !== undefined ? (
                <p id={`${durationId}-error`} role="alert" className="text-xs text-destructive">
                  {errors.duration}
                </p>
              ) : (
                <p id={`${durationId}-help`} className="text-xs text-muted-foreground tabular-nums">
                  {plannedEnd(fromChoice(choice), now)}
                </p>
              )}
            </fieldset>

            {formError !== "" && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <DialogFooter>
              <DialogClose render={<Button variant="outline" className="max-sm:h-10" />} disabled={inProgress}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={inProgress} className="max-sm:h-10">
                {inProgress ? "Creating…" : "Create access"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <PasswordScreen
            created={created}
            now={now}
            warned={warned && !copied}
            onCopied={() => setCopied(true)}
            onDone={askToClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The created password, shown only once, with exactly what "Copy invitation"
 * copies. No live region here: a screen reader would read the password out
 * loud. The announcements go through the shared region, without it.
 */
function PasswordScreen({
  created,
  now,
  warned,
  onCopied,
  onDone,
}: {
  created: Created
  now: number
  warned: boolean
  onCopied: () => void
  onDone: () => void
}) {
  const invitation = useCopy("Invitation copied")
  const password = useCopy("Password copied")
  const button = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLElement>(null)
  const { guest } = created
  const text = invitationText(guest.host, created.password, guest.expiresAt)
  const finish = endDate(guest)

  // The form has just disappeared along with focus: the next gesture is the copy.
  useEffect(() => {
    button.current?.focus()
  }, [])

  async function copyInvitation() {
    if (await invitation.copy(text)) onCopied()
  }

  async function copyPassword() {
    if (await password.copy(created.password)) return onCopied()
    // Fallback: the password selected, ready for the announced shortcut.
    if (code.current !== null) window.getSelection()?.selectAllChildren(code.current)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8 leading-snug wrap-anywhere">Access created for {guest.label}</DialogTitle>
        <DialogDescription className="text-pretty">
          Send these to {guest.label}: they open the address and enter the password. The password is shown only
          once.
        </DialogDescription>
      </DialogHeader>

      <dl className="divide-y rounded-lg border bg-muted/40 text-sm">
        <div className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
          <dt className="text-xs text-muted-foreground">Address</dt>
          <dd className="wrap-anywhere">https://{guest.host}</dd>
        </div>
        <div className="grid gap-0.5 py-1.5 pr-1.5 pl-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
          <dt className="text-xs text-muted-foreground">Password</dt>
          <dd className="flex min-w-0 items-center justify-between gap-2">
            <code
              ref={code}
              className="min-w-0 font-mono text-base font-semibold tracking-wide select-all wrap-anywhere"
            >
              {created.password}
            </code>
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={password.state === "copied" ? "Password copied" : "Copy password"}
              title="Copy password"
              onClick={() => void copyPassword()}
              className="text-muted-foreground hover:text-foreground max-sm:size-11"
            >
              {password.state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
            </Button>
          </dd>
        </div>
        {finish !== null && (
          <div className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
            <dt className="text-xs text-muted-foreground">Valid until</dt>
            <dd className="tabular-nums">
              {finish}
              <span className="ml-2 text-muted-foreground">{deadline(guest, now).text}</span>
            </dd>
          </div>
        )}
      </dl>

      <p className="-mt-2 text-xs text-muted-foreground">
        Copy invitation copies {finish === null ? "both lines" : "all three lines"}, ready to paste in a message.
      </p>

      {invitation.state === "failure" && <CopyFallback text={text} lines={3} onClose={invitation.reset} />}

      {warned && <Banner tone="attention">{COPY_WARNING}</Banner>}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} className="max-sm:h-10">
          {warned ? "Close without copying" : "Done"}
        </Button>
        <Button ref={button} onClick={() => void copyInvitation()} className="max-sm:h-10">
          {invitation.state === "copied" ? <Check /> : <Copy />}
          {invitation.state === "copied" ? "Copied" : "Copy invitation"}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * The confirmation of a revocation. The access stays in memory while the dialog
 * closes, so that its title does not empty during the animation; focus goes
 * where `focusReturn` says, the originating row having disappeared.
 */
export function RevokeGuestDialog({
  guest,
  open,
  inProgress,
  error,
  onConfirm,
  onCancel,
  focusReturn,
}: {
  guest: Guest | null
  open: boolean
  inProgress: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
  focusReturn: () => HTMLElement | boolean
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onCancel()
      }}
    >
      <AlertDialogContent finalFocus={focusReturn}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Revoke {guest?.label}'s access?</AlertDialogTitle>
          <AlertDialogDescription>
            {guest?.host} will refuse this password from their next request. To let them in again, create a new access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== "" && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={inProgress} className="max-sm:h-10">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={inProgress} onClick={onConfirm} className="max-sm:h-10">
            {inProgress ? "Revoking…" : "Revoke access"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
