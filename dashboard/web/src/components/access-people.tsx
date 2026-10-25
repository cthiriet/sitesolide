import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, ChevronRight, Copy, UserRoundMinus, UserRoundPlus, UsersRound, X } from "lucide-react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { RoleBars, Who } from "@/components/access-word"
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, INPUT_DIALOG, InlineEmpty, Panel } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { LockGlyph } from "@/components/unlock"
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
  leavingWarning,
  needsUnlock,
  passwordMessage,
  lowers,
  raiseNeedsUnlock,
  unlockLine,
  planAddition,
  plannedEnd,
  roleLabel,
  selfChangeWarning,
  sendLine,
  sendsLine,
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
 * access, waits for the unlock, then goes on; removing and lowering never
 * wait, and are confirmed first when they take someone out of the dashboard.
 * A Viewer or a Developer reads the same list, without a control, and whom
 * to ask.
 */

/** The native select the page styles, a field's look: see DESIGN.md, "a hand-drawn control takes a field's". */
const SELECT =
  "h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-sunk pr-8 pl-2.5 text-base shadow-well transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-default disabled:opacity-60 sm:h-9 sm:text-sm"

const CHEVRON = "pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"

function Select({
  label,
  value,
  onChange,
  disabled,
  role,
  className,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** A menu of roles shows the chosen one's bars before its word. */
  role?: AccessRole
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("relative", className)}>
      {role !== undefined && <RoleBars role={role} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(SELECT, role !== undefined && "pl-8")}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className={CHEVRON} />
    </div>
  )
}

/**
 * A row of the list, 44 px: who on the left, what it is muted beside them,
 * on a second line when the list is too narrow for both; the role on the
 * right, a menu when the viewer may change it, which also holds the removal.
 */
const LINE = "grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 pr-2 pl-4"
const ROLE_WIDTH = "w-[8.75rem] shrink-0"

const NONE = "none"
const toChoice = (seconds: number | null) => (seconds === null ? NONE : String(seconds))
const fromChoice = (choice: string) => (choice === NONE ? null : Number(choice))

type Created = { who: string; password: string; expiresAt: number | null }

type Notice = { who: string; role: AccessRole; line: string | null }

/**
 * What the field held when a person left to unlock at their provider, kept
 * in this tab for the way back: the page comes back to the field as it was,
 * and says the last step. Never a password: none is drawn before Add.
 */
const PENDING_KEY = "sitesolide.access.pending"
const PENDING_MAX_MS = 15 * 60_000

type PendingAdd = { slug: string; text: string; role: AccessRole; duration: string; at: number }

function keepPending(pending: PendingAdd): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // No storage in this tab: the field starts empty on the way back.
  }
}

/** The field as it was for this project, taken once; null when there is none, or it is old. */
function takePending(slug: string, now: number): PendingAdd | null {
  try {
    const text = window.sessionStorage.getItem(PENDING_KEY)
    if (text === null) return null
    window.sessionStorage.removeItem(PENDING_KEY)
    const pending = JSON.parse(text) as Partial<PendingAdd>
    if (pending.slug !== slug || typeof pending.text !== "string" || typeof pending.duration !== "string" || typeof pending.at !== "number") return null
    if (now - pending.at > PENDING_MAX_MS || !ROLE_KEYS.includes(pending.role as AccessRole)) return null
    return pending as PendingAdd
  } catch {
    return null
  }
}

const ROLE_KEYS = Object.keys(ROLE_TEXTS) as AccessRole[]

/** What was just given, and the line to send, copied as it is. */
function SendNotice({ notice, slug, onClose }: { notice: Notice; slug: string; onClose: () => void }) {
  const { state, copy, reset } = useCopy("Message copied")
  return (
    <div role="status" className="grid gap-2 border-b bg-cell px-4 py-3">
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
 * below: reference, read once, so a closed disclosure; each role's menu
 * says the same in one line beside each choice. The viewer's own rung is
 * marked.
 */
function RolesDisclosure({ yours }: { yours: AccessRole | null }) {
  return (
    <details className="group text-xs">
      <summary className="-mx-1 inline-flex cursor-pointer list-none items-center gap-1 rounded-sm px-1 text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        What each role can do
      </summary>
      <dl className="mt-2 grid gap-1.5 border-l pl-3">
        {ROLE_KEYS.map((role) => (
          <div key={role} className="grid gap-0.5 @xl:grid-cols-[7.5rem_minmax(0,1fr)] @xl:gap-3">
            <dt className="flex items-center gap-2 font-medium text-foreground">
              <RoleBars role={role} />
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
  /** The field came back from a person's unlock at their provider. */
  const [restored, setRestored] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const id = useId()

  useEffect(() => {
    const pending = takePending(page.slug, Date.now())
    if (pending === null) return
    setText(pending.text)
    setRole(pending.role)
    setDuration(pending.duration)
    setRestored(true)
    field.current?.focus()
  }, [page.slug])

  const plan = planAddition(text, page)
  const chosen: AccessRole = plan.state === "ready" && !plan.roles.includes(role) ? "visitor" : role
  // A domain and password access can only open the site: a word, not a menu.
  const onlyOpen = plan.kind === "domain" || (plan.state === "ready" ? plan.roles.length === 1 : page.grantable.length === 1)
  const covered = plan.state === "ready" && chosen === "visitor" ? plan.covered : null
  const offered = plan.state !== "blocked" && plan.state !== "existing" && covered === null
  const unlockFirst = plan.state === "ready" && needsUnlock(chosen, plan.password) && !actions.state.open
  // What the field holds is said as it is typed, a fault only once Add was pressed.
  const fault = plan.state === "blocked" || plan.state === "existing" || (tried && plan.state === "invalid")

  async function send(who: string, given: AccessRole, password: boolean) {
    setInProgress(true)
    try {
      const { status, body } = await putAccess(page.slug, who, given, password ? fromChoice(duration) : undefined)
      if ((status === 200 || status === 201) && body !== null && body.entry !== undefined) {
        setText("")
        setTried(false)
        setRole("visitor")
        setRestored(false)
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

  async function add(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress || !offered) return
    setTried(true)
    setError("")
    if (plan.state !== "ready" || plan.who === null) return field.current?.focus()
    const who = plan.who
    const password = plan.password
    // Unlocked here, the addition goes on; a person who leaves to unlock comes back to the field as it was.
    if (unlockFirst) {
      return actions.require(() => void send(who, chosen, password), {
        purpose: "add someone",
        beforeLeave: () => keepPending({ slug: page.slug, text, role: chosen, duration, at: Date.now() }),
      })
    }
    await send(who, chosen, password)
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
          <span className="flex h-10 w-36 shrink-0 items-center gap-2 rounded-lg border border-transparent px-2.5 text-sm text-secondary-foreground sm:h-9">
            <RoleBars role="visitor" />
            {roleLabel("visitor")}
          </span>
        ) : (
          <Select label="Role" value={chosen} role={chosen} onChange={(value) => setRole(value as AccessRole)} className="w-36 shrink-0">
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
        <Button type="submit" disabled={inProgress || !offered} className="h-10 shrink-0 sm:h-9">
          <UserRoundPlus />
          {inProgress ? "Adding…" : "Add"}
          {unlockFirst && !inProgress && <LockGlyph />}
        </Button>
      </div>
      <div id={hintId} className="grid gap-0.5 text-xs text-pretty wrap-break-word">
        {error !== "" ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : restored && actions.state.open && plan.state === "ready" ? (
          <p role="status" className={TONE_TEXT.ok}>
            Unlocked. Press Add to finish.
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
        {unlockFirst && offered && error === "" && <p className="text-muted-foreground">{unlockLine(chosen, plan.password)}</p>}
      </div>
    </form>
  )
}

/**
 * A row's role, the Google Docs way: a quiet button with the role's bars
 * and its word, opening a menu of the roles the viewer may give, each with
 * what it can do, the current one ticked, a raise that waits for the unlock
 * carrying its glyph; then, under a separator, *Remove access*, which still
 * confirms. Whoever may change nothing reads the word alone.
 */
function RoleMenu({
  row,
  slug,
  busy,
  locked,
  onRole,
  onRemove,
}: {
  row: EntryRow
  slug: string
  busy: boolean
  locked: boolean
  onRole: (role: AccessRole) => void
  onRemove: () => void
}) {
  const { entry } = row
  const trigger = useRef<HTMLButtonElement>(null)
  const word = (
    <>
      <RoleBars role={entry.role} muted={row.muted} />
      <span className={cn("min-w-0 flex-1 truncate text-left", row.muted ? "text-muted-foreground" : "text-secondary-foreground")}>{row.word}</span>
    </>
  )
  if (row.roles === null && !row.removable) {
    return <span className={cn(ROLE_WIDTH, "flex h-8 items-center gap-2 px-2.5 text-sm")}>{word}</span>
  }
  // Wait for the menu to close, and give focus back to its button, which a confirmation or the unlock returns to.
  const later = (action: () => void) =>
    window.setTimeout(() => {
      trigger.current?.focus()
      action()
    }, 0)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <Button
            ref={trigger}
            variant="ghost"
            aria-label={`Role of ${entry.who} on ${slug}: ${row.word}`}
            className={cn(ROLE_WIDTH, "justify-start gap-2 px-2.5 font-normal max-md:h-10")}
          />
        }
      >
        {word}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={entry.role}
          onValueChange={(value: AccessRole) => {
            if (value !== entry.role) later(() => onRole(value))
          }}
        >
          {(row.roles ?? [entry.role]).map((role) => (
            <DropdownMenuRadioItem key={role} value={role} disabled={row.roles === null} closeOnClick className="items-start gap-2.5 py-2 max-md:py-2.5">
              <RoleBars role={role} className="mt-1" />
              <span className="grid min-w-0 gap-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  {roleLabel(role)}
                  {locked && raiseNeedsUnlock(entry.role, role) && <LockGlyph />}
                </span>
                <span className="text-xs text-pretty whitespace-normal text-muted-foreground">{ROLE_TEXTS[role].can}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {row.removable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => later(onRemove)} className="h-9 max-md:h-10">
              <UserRoundMinus />
              Remove access
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One person, domain or password access: who, *(you)* on one's own, what it
 * is beside them, muted, and in attention a password access ending within a
 * day; who added it and when, in the name's tooltip; the role on the right.
 */
function EntryLine({
  row,
  slug,
  busy,
  locked,
  onRole,
  onRemove,
}: {
  row: EntryRow
  slug: string
  busy: boolean
  locked: boolean
  onRole: (role: AccessRole) => void
  onRemove: () => void
}) {
  const { entry } = row
  return (
    <li className={LINE}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 @xl/people:flex-nowrap">
        <span title={row.added ?? undefined} className={cn("min-w-0 font-medium wrap-break-word @xl/people:shrink-0", row.muted ? "text-muted-foreground" : "text-strong")}>
          <Who value={entry.who} />
          {row.self && <span className="font-normal text-muted-foreground"> (you)</span>}
          {row.added !== null && <span className="sr-only">, {row.added}</span>}
        </span>
        {row.what !== null && (
          <span
            title={row.what}
            className={cn(
              "min-w-0 basis-full text-xs @xl/people:basis-auto @xl/people:truncate @xl/people:text-[0.8125rem]",
              row.whatTone === "attention" && !row.muted ? TONE_TEXT.attention : "text-muted-foreground",
            )}
          >
            {row.what}
          </span>
        )}
      </div>
      <RoleMenu row={row} slug={slug} busy={busy} locked={locked} onRole={onRole} onRemove={onRemove} />
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

/**
 * A change waiting for its confirmation: someone's removal, an Admin lowering
 * their own role, or a lowering that takes someone out of the dashboard.
 */
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
      // Raised to Viewer or above: the same line to send them as adding them gives.
      if (sendsLine(entry.role, role)) setNotice({ who: entry.who, role, line: sendLine({ ...entry, role }, page) })
      else if (notice?.who === entry.who) setNotice(null)
      onChanged()
      return null
    }
    return actions.refusal(refusalOf(status, body))
  }

  async function changeRole(entry: EntryView, role: AccessRole) {
    if (role === entry.role) return
    setRowError("")
    // Unlocked here, the role picked is given at once.
    if (raiseNeedsUnlock(entry.role, role) && !actions.state.open) {
      return actions.require(() => void applyRole(entry, role), { purpose: `give ${roleLabel(role)}` })
    }
    // An Admin lowering themselves gives up managing the project, and a
    // lowering may take someone out of the dashboard: said first.
    if ((own(entry) && entry.role === "admin" && lowers(entry.role, role)) || leavingWarning(entry.who, role, page) !== null) {
      return setPending({ entry, role, open: true, inProgress: false, error: "" })
    }
    await applyRole(entry, role)
  }

  async function applyRole(entry: EntryView, role: AccessRole) {
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
  const leaving = pending === null ? null : leavingWarning(pending.entry.who, pending.role, page)

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
        <RolesDisclosure yours={yours} />
      </div>
      {notice !== null && <SendNotice notice={notice} slug={page.slug} onClose={() => setNotice(null)} />}
      {rowError !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{rowError}</Banner>
        </div>
      )}

      {count === 0 ? (
        <InlineEmpty icon={UsersRound}>Nobody else has access to {page.slug} yet.</InlineEmpty>
      ) : (
        <ul className="@container/people divide-y divide-divider" aria-label={`Who has access to ${page.slug}`}>
          {entries.map((entry) => (
            <EntryLine
              key={entry.who}
              row={entryRow(entry, page, now)}
              slug={page.slug}
              busy={busy === entry.who}
              locked={!actions.state.open}
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
              ) : self ? (
                `Become ${pending === null || pending.role === null ? "" : roleLabel(pending.role)} on ${page.slug}?`
              ) : (
                <>
                  Change <Who value={pending?.entry.who ?? ""} /> to {pending === null || pending.role === null ? "" : roleLabel(pending.role)}?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {self
                ? selfChangeWarning(page.slug)
                : !removing
                  ? `They keep opening ${page.slug} when its access is restricted, and lose what more they could do at their next request.`
                  : pending?.entry.kind === "domain"
                    ? `Everyone at ${pending.entry.who.slice(1)} loses access at their next request, except the people added by name.`
                    : pending?.entry.kind === "password"
                      ? "Their password stops opening the site at their next request."
                      : `They lose access to ${page.slug} at their next request, on the site and in the dashboard.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {leaving !== null && <Banner tone="attention">{leaving}</Banner>}
          {pending !== null && pending.error !== "" && <Banner tone="error">{pending.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending?.inProgress ?? false} onClick={() => void confirm()} className="max-sm:h-11">
              {pending?.inProgress ? (removing ? "Removing…" : "Saving…") : removing ? "Remove" : self ? "Change my role" : "Change role"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
