import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, ChevronRight, Copy, UserRoundPlus, X } from "lucide-react"
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
import { Banner, EmptyState, INPUT_DIALOG, Panel } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { putAccess, removeAccess } from "@/lib/api"
import {
  DEFAULT_PASSWORD_DURATION_S,
  PASSWORD_DURATIONS,
  ROLE_TEXTS,
  alsoOpens,
  askAnAdmin,
  closeOutcome,
  entryRow,
  grantSentence,
  inertNote,
  needsUnlock,
  passwordMessage,
  lowers,
  raiseNeedsUnlock,
  planAddition,
  plannedEnd,
  roleLabel,
  selfChangeWarning,
  sendLine,
  sortEntries,
  type EntryRow,
} from "@/lib/access"
import { dateTime } from "@/lib/format"
import { refusalOf } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { AccessPageResponse, AccessRole, EntryView, GeneralAccess } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * People with access, as a "Share" dialog lays them out: the field that adds
 * someone at the top, then everyone on the project's list and their role, a
 * menu on each row and its removal. Under the list, once, who opens the site
 * without being on it: the owner, and the admin emails set on the server.
 *
 * The page sends each change as it is made; the steward judges it and its
 * refusal is shown as it stands. Giving a role above Can open, or password
 * access, waits for the unlock; removing and lowering never do. A Viewer or
 * a Developer reads the same list, without a control, and whom to ask.
 */

/** The native select the page styles, a field's look: see DESIGN.md, "a hand-drawn control takes a field's". */
const SELECT =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent pr-8 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60 sm:h-9 sm:text-sm dark:bg-input/30"

const CHEVRON = "pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"

function Select({
  label,
  value,
  onChange,
  disabled,
  className,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("relative", className)}>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={SELECT}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className={CHEVRON} />
    </div>
  )
}

/**
 * A row of the list: who on the left, wrapping inside its column; the role
 * and the removal on the right, on the same line even on a phone, where the
 * menu narrows.
 */
const LINE = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5"
const ROLE_WIDTH = "w-[7.75rem] shrink-0 md:w-36"

const NONE = "none"
const toChoice = (seconds: number | null) => (seconds === null ? NONE : String(seconds))
const fromChoice = (choice: string) => (choice === NONE ? null : Number(choice))

type Created = { who: string; password: string; expiresAt: number | null }

type Notice = { who: string; role: AccessRole; line: string | null }

/** What was just given, and the line to send, copied as it is. */
function SendNotice({ notice, slug, onClose }: { notice: Notice; slug: string; onClose: () => void }) {
  const { state, copy, reset } = useCopy("Message copied")
  return (
    <div role="status" className="grid gap-2 border-b bg-muted/40 px-4 py-3">
      <div className="flex items-start gap-2">
        <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT.ok)} />
        <p className="min-w-0 flex-1 text-pretty wrap-break-word">
          {grantSentence(notice.who, notice.role, slug)}
          {notice.line !== null && " No email is sent: send them this."}
        </p>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onClose} className="-my-1 text-muted-foreground max-md:size-10">
          <X />
        </Button>
      </div>
      {notice.line !== null &&
        (state === "failure" ? (
          <CopyFallback text={notice.line} onClose={reset} />
        ) : (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-card py-1.5 pr-1.5 pl-3">
            <p className="min-w-0 flex-1 text-sm wrap-anywhere">{notice.line}</p>
            <Button variant="outline" size="sm" onClick={() => void copy(notice.line!)} className="max-md:h-10">
              {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
              {state === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>
        ))}
    </div>
  )
}

/**
 * What each role can do, from Can open to Admin, each including the ones
 * below: a disclosure a newcomer opens once, open from the start for whoever
 * only reads the list. The viewer's own rung is marked.
 */
function RolesDisclosure({ yours, open }: { yours: AccessRole | null; open: boolean }) {
  return (
    <details open={open} className="group text-xs">
      <summary className="-mx-1 inline-flex cursor-pointer list-none items-center gap-1 rounded-sm px-1 text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        What each role can do
      </summary>
      <dl className="mt-2 grid gap-1.5 border-l pl-3">
        {(Object.keys(ROLE_TEXTS) as AccessRole[]).map((role) => (
          <div key={role} className="grid gap-0.5 @xl:grid-cols-[6.5rem_minmax(0,1fr)] @xl:gap-3">
            <dt className="font-medium text-foreground">
              {ROLE_TEXTS[role].label}
              {role === yours && <span className="font-normal text-muted-foreground"> (your role)</span>}
            </dt>
            <dd className="text-pretty text-muted-foreground">{ROLE_TEXTS[role].can}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/** The field that adds someone: who, their role, and for password access how long it lasts. */
function AddPeople({
  page,
  now,
  onAdded,
}: {
  page: AccessPageResponse
  now: number
  onAdded: (added: { entry: EntryView; password: string | null }) => void
}) {
  const actions = useSecretsActions()
  const [text, setText] = useState("")
  const [role, setRole] = useState<AccessRole>("visitor")
  const [duration, setDuration] = useState(toChoice(DEFAULT_PASSWORD_DURATION_S))
  const [tried, setTried] = useState(false)
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()

  const plan = planAddition(text, page)
  const chosen: AccessRole = plan.state === "ready" && !plan.roles.includes(role) ? "visitor" : role
  // A domain and password access can only open the site: a word, not a menu.
  const onlyOpen = plan.kind === "domain" || (plan.state === "ready" ? plan.roles.length === 1 : page.grantable.length === 1)
  const covered = plan.state === "ready" && chosen === "visitor" ? plan.covered : null
  const offered = plan.state !== "blocked" && plan.state !== "existing" && covered === null
  const unlockFirst = plan.state === "ready" && needsUnlock(chosen, plan.password) && !actions.state.open
  // What the field holds is said as it is typed, a fault only once Add was pressed.
  const fault = plan.state === "blocked" || plan.state === "existing" || (tried && plan.state === "invalid")

  async function add(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress || !offered) return
    setTried(true)
    setError("")
    if (plan.state !== "ready" || plan.who === null) return field.current?.focus()
    if (unlockFirst) return actions.unlock()
    setInProgress(true)
    try {
      const { status, body } = await putAccess(page.slug, plan.who, chosen, plan.password ? fromChoice(duration) : undefined)
      if ((status === 200 || status === 201) && body !== null && body.entry !== undefined) {
        setText("")
        setTried(false)
        setRole("visitor")
        onAdded({ entry: body.entry, password: typeof body.password === "string" ? body.password : null })
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

  const hintId = `${id}-hint`
  return (
    <form noValidate onSubmit={(event) => void add(event)} className="grid gap-2">
      <label htmlFor={id} className="text-sm leading-none font-medium">
        Add people
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
          placeholder={page.signIn.configured ? "name@company.com or @company.com" : "name@company.com"}
          onChange={(event) => {
            setText(event.target.value)
            setError("")
          }}
          aria-invalid={fault || error !== "" || undefined}
          aria-describedby={hintId}
          className="h-10 min-w-0 flex-1 basis-60 sm:h-9"
        />
        {onlyOpen ? (
          <span className="flex h-10 w-36 shrink-0 items-center rounded-lg border border-transparent px-2.5 text-sm text-secondary-foreground sm:h-9">
            {roleLabel("visitor")}
          </span>
        ) : (
          <Select label="Role" value={chosen} onChange={(value) => setRole(value as AccessRole)} className="w-36 shrink-0">
            {page.grantable.map((option) => (
              <option key={option} value={option} disabled={plan.state === "ready" && !plan.roles.includes(option)} className="text-foreground">
                {roleLabel(option)}
              </option>
            ))}
          </Select>
        )}
        {plan.state === "ready" && plan.password && (
          <Select label="Password access lasts" value={duration} onChange={setDuration} className="w-32 shrink-0">
            {PASSWORD_DURATIONS.map((option) => (
              <option key={toChoice(option.seconds)} value={toChoice(option.seconds)} className="text-foreground">
                {option.label}
              </option>
            ))}
          </Select>
        )}
        <Button type="submit" variant={unlockFirst ? "outline" : "default"} disabled={inProgress || !offered} className="h-10 shrink-0 sm:h-9">
          <UserRoundPlus />
          {inProgress ? "Adding…" : unlockFirst ? "Unlock to add" : "Add"}
        </Button>
      </div>
      <div id={hintId} className="grid gap-0.5 text-xs text-pretty wrap-break-word">
        {error !== "" ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : covered !== null ? (
          <p className="text-muted-foreground">{covered}</p>
        ) : (
          <p role={fault ? "alert" : undefined} className={fault ? "text-destructive" : "text-muted-foreground"}>
            {plan.state === "invalid" && !tried ? "Keep typing: an email, or a domain with its @." : plan.hint}
          </p>
        )}
        {plan.state === "ready" && plan.password && error === "" && (
          <p className="text-muted-foreground tabular-nums">{plannedEnd(fromChoice(duration), now)}</p>
        )}
        {unlockFirst && offered && error === "" && (
          <p className="text-muted-foreground">
            {plan.password ? "Password access lets someone from outside the company in" : `${roleLabel(chosen)} is more than opening the site`}: it waits for
            the unlock.
          </p>
        )}
      </div>
    </form>
  )
}

/** One person, domain or password access, with its role and its removal when the viewer may change them. */
function EntryLine({
  row,
  slug,
  busy,
  spacer,
  onRole,
  onRemove,
}: {
  row: EntryRow
  slug: string
  busy: boolean
  /** Keep the removal's place when there is none on this row, so that the roles stay aligned. */
  spacer: boolean
  onRole: (role: AccessRole) => void
  onRemove: () => void
}) {
  const { entry } = row
  return (
    <li className={LINE}>
      <div className="grid min-w-0 gap-0.5">
        <span className={cn("font-medium wrap-break-word", row.muted && "text-muted-foreground")}>
          <Who value={entry.who} />
          {row.self && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        {row.what !== null && (
          <span className={cn("text-xs", row.whatTone === "attention" && !row.muted ? TONE_TEXT.attention : "text-muted-foreground")}>{row.what}</span>
        )}
        {row.added !== null && <span className="text-xs text-muted-foreground">{row.added}</span>}
      </div>
      <div className="flex items-center gap-1">
        {row.roles === null ? (
          <span className={cn(ROLE_WIDTH, "px-2.5 text-sm", row.muted ? "text-muted-foreground" : "text-secondary-foreground")}>{row.word}</span>
        ) : (
          <Select label={`Role of ${entry.who} on ${slug}`} value={entry.role} disabled={busy} onChange={(value) => onRole(value as AccessRole)} className={ROLE_WIDTH}>
            {row.roles.map((option) => (
              <option key={option} value={option} className="text-foreground">
                {roleLabel(option)}
              </option>
            ))}
          </Select>
        )}
        {row.removable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            title={`Remove ${entry.who}`}
            aria-label={`Remove ${entry.who} from ${slug}`}
            onClick={onRemove}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-md:size-10 dark:hover:bg-destructive/15"
          >
            <X />
          </Button>
        ) : (
          spacer && <span aria-hidden="true" className="size-8 max-md:size-10" />
        )}
      </div>
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
                Password access for <Who value={created.who} />
              </DialogTitle>
              <DialogDescription className="text-pretty">
                Send them the address and this password: it opens the site, and nothing in the dashboard. It is shown
                only once.
              </DialogDescription>
            </DialogHeader>

            <dl className="divide-y divide-divider rounded-lg border bg-muted/40 text-sm">
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

/** A change waiting for its confirmation: someone's removal, or an Admin lowering their own role. */
type Pending = { entry: EntryView; role: AccessRole | null; open: boolean; inProgress: boolean; error: string }

/**
 * The project's people with access. `page` is the steward's answer to
 * `/api/access`; `onChanged` reads it again after each change. Whoever may
 * give no role reads the list as it is, and whom to ask.
 */
export function PeopleWithAccess({
  page,
  general,
  now,
  onChanged,
}: {
  page: AccessPageResponse
  /** How the site opens now, from the snapshot: Can open only matters when it is restricted. */
  general: GeneralAccess
  now: number
  onChanged: () => void
}) {
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState("")
  const [pending, setPending] = useState<Pending | null>(null)

  const manages = page.grantable.length > 0
  const entries = sortEntries(page.entries, now)
  const yours = page.you.kind === "person" ? page.you.role : null
  const own = (entry: EntryView) => page.you.kind === "person" && entry.who === page.you.email

  async function sendRole(entry: EntryView, role: AccessRole): Promise<string | null> {
    const { status, body } = await putAccess(page.slug, entry.who, role)
    if (status === 200 && body !== null) {
      announce(grantSentence(entry.who, role, page.slug))
      if (notice?.who === entry.who) setNotice(null)
      onChanged()
      return null
    }
    return actions.refusal(refusalOf(status, body))
  }

  async function changeRole(entry: EntryView, role: AccessRole) {
    if (role === entry.role) return
    setRowError("")
    if (raiseNeedsUnlock(entry.role, role) && !actions.state.open) return actions.unlock()
    // An Admin lowering themselves gives up managing the project: said first.
    if (own(entry) && entry.role === "admin" && lowers(entry.role, role)) {
      return setPending({ entry, role, open: true, inProgress: false, error: "" })
    }
    setBusy(entry.who)
    try {
      const message = await sendRole(entry, role)
      if (message !== null) setRowError(`${entry.who}: ${message}`)
    } finally {
      setBusy(null)
    }
  }

  async function confirm() {
    if (pending === null) return
    const { entry, role } = pending
    setPending({ ...pending, inProgress: true, error: "" })
    if (role !== null) {
      const message = await sendRole(entry, role)
      if (message === null) return setPending({ ...pending, open: false, inProgress: false })
      return setPending({ ...pending, inProgress: false, error: message })
    }
    const { status, body } = await removeAccess(page.slug, entry.who)
    if (status === 200) {
      setPending({ ...pending, open: false, inProgress: false })
      announce(`${entry.who} no longer has access to ${page.slug}.`)
      if (notice?.who === entry.who) setNotice(null)
      return onChanged()
    }
    const message = actions.refusal(refusalOf(status, body))
    if (message === null) return setPending({ ...pending, open: false, inProgress: false })
    setPending({ ...pending, inProgress: false, error: message })
  }

  const count = entries.length
  const removing = pending !== null && pending.role === null
  const self = pending !== null && own(pending.entry) && pending.entry.role === "admin"

  return (
    <Panel title="People with access" count={count > 0 ? count : undefined} description={inertNote(page.slug, general, manages) ?? undefined} full>
      <div className="@container grid gap-3 border-b p-4">
        {manages ? (
          <AddPeople
            page={page}
            now={now}
            onAdded={({ entry, password }) => {
              if (password !== null) {
                setNotice(null)
                setCreated({ who: entry.who, password, expiresAt: entry.password?.expiresAt ?? null })
                announce(`Password access given to ${entry.who}. Copy the password now: it won't be shown again.`)
              } else {
                setNotice({ who: entry.who, role: entry.role, line: sendLine(entry, page) })
                announce(grantSentence(entry.who, entry.role, page.slug))
              }
              onChanged()
            }}
          />
        ) : (
          <p className="text-sm text-pretty wrap-break-word">{askAnAdmin(page.entries)}</p>
        )}
        <RolesDisclosure yours={yours} open={!manages} />
      </div>
      {notice !== null && <SendNotice notice={notice} slug={page.slug} onClose={() => setNotice(null)} />}
      {rowError !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{rowError}</Banner>
        </div>
      )}

      {count === 0 ? (
        <EmptyState compact title={`Nobody else has access to ${page.slug} yet`}>
          {manages ? "Add people above: they open the site when its access is restricted, and with a role they see or manage it here." : null}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-divider" aria-label={`Who has access to ${page.slug}`}>
          {entries.map((entry) => (
            <EntryLine
              key={entry.who}
              row={entryRow(entry, page, now)}
              slug={page.slug}
              busy={busy === entry.who}
              spacer={manages}
              onRole={(role) => void changeRole(entry, role)}
              onRemove={() => setPending({ entry, role: null, open: true, inProgress: false, error: "" })}
            />
          ))}
        </ul>
      )}

      <p className="border-t px-4 py-3 text-xs text-pretty text-muted-foreground wrap-break-word">{alsoOpens(page.signIn.admins)}</p>

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
              {removing ? (
                <>
                  Remove {self ? "yourself" : <Who value={pending.entry.who} />} from {page.slug}?
                </>
              ) : (
                `Become ${pending === null || pending.role === null ? "" : roleLabel(pending.role)} on ${page.slug}?`
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {self
                ? selfChangeWarning(page.slug)
                : pending?.entry.kind === "domain"
                  ? `Everyone at ${pending.entry.who.slice(1)} loses access at their next request, except the people added by name.`
                  : pending?.entry.kind === "password"
                    ? "Their password stops opening the site at their next request."
                    : `They lose access to ${page.slug} at their next request, on the site and in the dashboard.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending !== null && pending.error !== "" && <Banner tone="error">{pending.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending?.inProgress ?? false} onClick={() => void confirm()} className="max-sm:h-11">
              {pending?.inProgress ? (removing ? "Removing…" : "Saving…") : removing ? "Remove" : "Change my role"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
