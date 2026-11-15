import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, Copy, UserRoundMinus, UserRoundPlus, UsersRound } from "lucide-react"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Who } from "@/components/access-word"
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, INPUT_DIALOG, InlineEmpty, Panel } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { LockGlyph } from "@/components/unlock"
import { putAccess, removeAccess } from "@/lib/api"
import {
  DEFAULT_PASSWORD_DURATION_S,
  PASSWORD_DURATIONS,
  closeOutcome,
  givenText,
  guestExpiry,
  inertNote,
  isExpired,
  passwordMessage,
  planGuest,
  plannedEnd,
  sortGuests,
} from "@/lib/access"
import { dateTime } from "@/lib/format"
import { refusalOf } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { AccessPageResponse, EntryView, GeneralAccess } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's guests: each opens the site with a password the steward draws,
 * and nothing more, no dashboard and no token. The field gives one access,
 * for one of the four durations, and the password is shown once; each row
 * says who, who gave it and when, its expiry, and removes it.
 *
 * The page sends each change as it is made; the steward judges it and its
 * refusal is shown as it stands. Giving access waits for the unlock, then
 * goes on; removing never waits, and is confirmed first.
 */

/** The native select the page styles, a field's look: see DESIGN.md, "a hand-drawn control takes a field's". */
const SELECT =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-sunk pr-8 pl-2.5 text-base shadow-well transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-default disabled:opacity-60 sm:h-9 sm:text-sm"

const NONE = "none"
const toChoice = (seconds: number | null) => (seconds === null ? NONE : String(seconds))
const fromChoice = (choice: string) => (choice === NONE ? null : Number(choice))

type Created = { who: string; password: string; expiresAt: number | null }

/** The field that gives a guest access: their email, how long it lasts, and Give access. */
function AddGuest({ page, now, onAdded }: { page: AccessPageResponse; now: number; onAdded: (created: Created | null, entry: EntryView) => void }) {
  const actions = useSecretsActions()
  const [text, setText] = useState("")
  const [duration, setDuration] = useState(toChoice(DEFAULT_PASSWORD_DURATION_S))
  const [tried, setTried] = useState(false)
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()
  const hintId = `${id}-hint`

  const plan = planGuest(text, page.entries)
  const locked = !actions.state.open
  // What the field holds is said as it is typed, a fault only once the button was pressed.
  const fault = plan.state === "existing" || (tried && plan.state === "invalid")

  async function send(who: string) {
    setInProgress(true)
    try {
      const { status, body } = await putAccess(page.slug, who, fromChoice(duration))
      if ((status === 200 || status === 201) && body !== null && body.entry !== undefined) {
        setText("")
        setTried(false)
        const password = typeof body.password === "string" ? body.password : null
        onAdded(password === null ? null : { who: body.entry.who, password, expiresAt: body.entry.expiresAt }, body.entry)
        return
      }
      const message = actions.refusal(refusalOf(status, body))
      if (message !== null) {
        setError(message)
        field.current?.focus()
      }
    } finally {
      setInProgress(false)
    }
  }

  function add(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress || plan.state === "existing") return
    setTried(true)
    setError("")
    if (plan.state !== "ready" || plan.who === null) return field.current?.focus()
    const who = plan.who
    actions.require(() => void send(who), { purpose: "give access" })
  }

  return (
    <form noValidate onSubmit={add} className="grid gap-2">
      <label htmlFor={id} className="text-sm leading-none font-medium">
        Give access
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={field}
          id={id}
          value={text}
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="name@example.com"
          onChange={(event) => {
            setText(event.target.value)
            setError("")
          }}
          aria-invalid={fault || error !== "" || undefined}
          aria-describedby={hintId}
          className="h-10 min-w-0 flex-1 basis-56 sm:h-9"
        />
        <div className="relative w-32 shrink-0">
          <select aria-label="Access lasts" value={duration} onChange={(event) => setDuration(event.target.value)} className={SELECT}>
            {PASSWORD_DURATIONS.map((option) => (
              <option key={toChoice(option.seconds)} value={toChoice(option.seconds)} className="text-foreground">
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        <Button type="submit" disabled={inProgress || plan.state === "existing"} className="h-10 shrink-0 sm:h-9">
          <UserRoundPlus />
          {inProgress ? "Giving…" : "Give access"}
          {locked && !inProgress && <LockGlyph />}
        </Button>
      </div>
      <div id={hintId} className="grid gap-0.5 text-xs text-pretty wrap-break-word">
        {error !== "" ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <p role={fault ? "alert" : undefined} className={fault ? "text-destructive" : "text-muted-foreground"}>
            {plan.state === "invalid" && !tried ? "Keep typing: an email, like name@example.com." : plan.hint}
          </p>
        )}
        {plan.state === "ready" && error === "" && <p className="text-muted-foreground tabular-nums">{plannedEnd(fromChoice(duration), now)}</p>}
      </div>
    </form>
  )
}

/** One guest: their email, who gave it and when, its expiry, and Remove. */
function GuestLine({ entry, now, busy, onRemove }: { entry: EntryView; now: number; busy: boolean; onRemove: () => void }) {
  const expired = isExpired(entry, now)
  const expiry = guestExpiry(entry, now)
  return (
    <li className="flex min-h-11 items-center gap-3 py-1.5 pr-2 pl-4">
      <div className="grid min-w-0 flex-1 gap-0.5 @xl/guests:flex @xl/guests:items-baseline @xl/guests:gap-3">
        <span className={cn("min-w-0 font-medium wrap-break-word @xl/guests:shrink-0", expired ? "text-muted-foreground" : "text-strong")}>
          <Who value={entry.who} />
        </span>
        <span className="min-w-0 text-xs text-muted-foreground @xl/guests:truncate @xl/guests:text-[0.8125rem]">
          <span title={entry.expiresAt === null ? undefined : dateTime(entry.expiresAt)} className={cn(!expired && expiry.tone === "attention" && TONE_TEXT.attention)}>
            {expiry.text}
          </span>
          <span aria-hidden="true"> · </span>
          <span title={dateTime(entry.createdAt)}>{givenText(entry, now)}</span>
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`Remove ${entry.who}`}
        onClick={onRemove}
        className="shrink-0 text-muted-foreground hover:text-destructive max-md:h-10"
      >
        <UserRoundMinus />
        <span className="max-sm:sr-only">Remove</span>
      </Button>
    </li>
  )
}

/**
 * The drawn password, shown only once, with exactly what "Copy message"
 * copies. Closing it without having copied takes two gestures. No live
 * region: a screen reader would read the password out loud.
 */
function PasswordDialog({ created, url, onClose }: { created: Created | null; url: string; onClose: () => void }) {
  const announce = useAnnounce()
  const message = useCopy("Message copied")
  const password = useCopy("Password copied")
  const [copied, setCopied] = useState(false)
  const [warned, setWarned] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLElement>(null)
  const text = created === null ? "" : passwordMessage(url, created.password, created.expiresAt)

  useEffect(() => {
    setCopied(false)
    setWarned(false)
  }, [created])

  function askToClose() {
    if (closeOutcome(copied, warned) === "close") return onClose()
    setWarned(true)
    announce("You haven't copied the password. It can't be shown again.")
  }

  async function copyMessage() {
    if (await message.copy(text)) setCopied(true)
  }

  async function copyPassword() {
    if (created === null) return
    if (await password.copy(created.password)) return setCopied(true)
    if (code.current !== null) window.getSelection()?.selectAllChildren(code.current)
  }

  return (
    <Dialog open={created !== null} onOpenChange={(next) => !next && askToClose()}>
      <DialogContent className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)} initialFocus={() => button.current}>
        {created !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-8 leading-snug wrap-break-word">
                Password for <Who value={created.who} />
              </DialogTitle>
              <DialogDescription className="text-pretty">Send them the address and this password. It opens this site only, and is shown once.</DialogDescription>
            </DialogHeader>

            <dl className="divide-y divide-divider rounded-lg border bg-cell text-sm">
              <div className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                <dt className="text-xs text-muted-foreground">Address</dt>
                <dd className="wrap-anywhere">{url}</dd>
              </div>
              <div className="grid gap-0.5 py-1.5 pr-1.5 pl-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                <dt className="text-xs text-muted-foreground">Password</dt>
                <dd className="flex min-w-0 items-center justify-between gap-2">
                  <code ref={code} className="min-w-0 font-mono text-base font-semibold tracking-wide select-all wrap-anywhere">
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
              <div className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                <dt className="text-xs text-muted-foreground">Valid until</dt>
                <dd className="tabular-nums">{created.expiresAt === null ? "Until removed" : dateTime(created.expiresAt)}</dd>
              </div>
            </dl>

            {message.state === "failure" && <CopyFallback text={text} lines={3} onClose={message.reset} />}
            {warned && !copied && <Banner tone="attention">You haven't copied the password. It can't be shown again.</Banner>}

            <DialogFooter>
              <Button variant="outline" onClick={askToClose} className="max-sm:h-10">
                {warned && !copied ? "Close without copying" : "Done"}
              </Button>
              <Button ref={button} onClick={() => void copyMessage()} className="max-sm:h-10">
                {message.state === "copied" ? <Check /> : <Copy />}
                {message.state === "copied" ? "Copied" : "Copy message"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

type Pending = { entry: EntryView; open: boolean; inProgress: boolean; error: string }

/**
 * The project's guests. `page` is the steward's answer to `/api/access`;
 * `onChanged` reads it again after each change.
 */
export function Guests({
  page,
  general,
  now,
  onChanged,
}: {
  page: AccessPageResponse
  /** How the site opens now, from the snapshot: guests only matter when it is restricted. */
  general: GeneralAccess
  now: number
  onChanged: () => void
}) {
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const [created, setCreated] = useState<Created | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const entries = sortGuests(page.entries, now)

  async function confirm() {
    if (pending === null) return
    const { entry } = pending
    setPending({ ...pending, inProgress: true, error: "" })
    const { status, body } = await removeAccess(page.slug, entry.who)
    if (status === 200) {
      setPending({ ...pending, open: false, inProgress: false })
      announce(`${entry.who} no longer has access to ${page.slug}.`)
      return onChanged()
    }
    const message = actions.refusal(refusalOf(status, body))
    if (message === null) return setPending({ ...pending, open: false, inProgress: false })
    setPending({ ...pending, inProgress: false, error: message })
  }

  return (
    <Panel title="Guests" count={entries.length > 0 ? entries.length : undefined} description={inertNote(page.slug, general) ?? undefined} full>
      <div className="border-b p-4">
        <AddGuest
          page={page}
          now={now}
          onAdded={(given, entry) => {
            if (given !== null) {
              setCreated(given)
              announce(`Access given to ${entry.who}. Copy the password now: it won't be shown again.`)
            } else {
              announce(`${entry.who} is already a guest.`)
            }
            onChanged()
          }}
        />
      </div>

      {entries.length === 0 ? (
        <InlineEmpty icon={UsersRound}>No guest yet. Only you open {page.slug} when it's restricted.</InlineEmpty>
      ) : (
        <ul className="@container/guests divide-y divide-divider" aria-label={`Guests of ${page.slug}`}>
          {entries.map((entry) => (
            <GuestLine
              key={entry.who}
              entry={entry}
              now={now}
              busy={pending?.inProgress === true && pending.entry.who === entry.who}
              onRemove={() => setPending({ entry, open: true, inProgress: false, error: "" })}
            />
          ))}
        </ul>
      )}

      <PasswordDialog created={created} url={page.url} onClose={() => setCreated(null)} />

      <AlertDialog
        open={pending?.open ?? false}
        onOpenChange={(next) => {
          if (!next && pending !== null && !pending.inProgress) setPending({ ...pending, open: false })
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-left max-sm:place-items-start">
            <AlertDialogTitle className="wrap-break-word">
              Remove <Who value={pending?.entry.who ?? ""} />?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">Their password stops opening {page.slug} at their next request.</AlertDialogDescription>
          </AlertDialogHeader>
          {pending !== null && pending.error !== "" && <Banner tone="error">{pending.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending?.inProgress ?? false} onClick={() => void confirm()} className="max-sm:h-11">
              {pending?.inProgress ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
