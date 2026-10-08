import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, ChevronDown, Copy, UserRoundPlus, X } from "lucide-react"
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
import { CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, EmptyState, INPUT_DIALOG, Panel } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { putAccess, removeAccess } from "@/lib/api"
import {
  DEFAULT_PASSWORD_DURATION_S,
  OWNER_TEXT,
  PASSWORD_DURATIONS,
  ROLE_TEXTS,
  closeOutcome,
  entryRow,
  inertNote,
  needsUnlock,
  passwordMessage,
  raiseNeedsUnlock,
  planAddition,
  plannedEnd,
  roleLabel,
  sendLine,
  sortEntries,
  type EntryRow,
  type RoleText,
} from "@/lib/access"
import { dateTime } from "@/lib/format"
import { refusalOf } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { AccessPageResponse, AccessRole, EntryView, GeneralAccess } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * People with access, as a "Share" dialog lays them out: the field that adds
 * someone at the top, then everyone who has access to the project and their
 * role, a menu on each row and its removal. The owner first, who is on no
 * list, and the emails the server lets into every restricted site last, so
 * that the whole answer to "who can do what" is on one screen.
 *
 * The page sends each change as it is made; the steward judges it and its
 * refusal is shown as it stands. Giving a role above Can open, or password
 * access, waits for the unlock; removing and lowering never do.
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

/** The line to send after adding someone, copied as it is. */
function SendNotice({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { state, copy, reset } = useCopy("Message copied")
  return (
    <div role="status" className="grid gap-2 border-b bg-muted/40 px-4 py-3">
      <div className="flex items-start gap-2">
        <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT.ok)} />
        <p className="min-w-0 flex-1 text-pretty">
          <span className="font-medium wrap-anywhere">{notice.who}</span> added as {roleLabel(notice.role)}.
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
  const unlockFirst = plan.state === "ready" && needsUnlock(chosen, plan.password) && !actions.state.open
  // What the field holds is said as it is typed, a fault only once Add was pressed.
  const fault = plan.state === "blocked" || plan.state === "existing" || (tried && plan.state === "invalid")

  async function add(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
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
    <form noValidate onSubmit={(event) => void add(event)} className="grid gap-2 border-b p-4">
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
        <Select label="Role" value={chosen} onChange={(value) => setRole(value as AccessRole)} className="w-36 shrink-0">
          {page.grantable.map((option) => (
            <option key={option} value={option} disabled={plan.state === "ready" && !plan.roles.includes(option)} className="text-foreground">
              {roleLabel(option)}
            </option>
          ))}
        </Select>
        {plan.state === "ready" && plan.password && (
          <Select label="Password access lasts" value={duration} onChange={setDuration} className="w-32 shrink-0">
            {PASSWORD_DURATIONS.map((option) => (
              <option key={toChoice(option.seconds)} value={toChoice(option.seconds)} className="text-foreground">
                {option.label}
              </option>
            ))}
          </Select>
        )}
        <Button type="submit" variant={unlockFirst ? "outline" : "default"} disabled={inProgress} className="h-10 shrink-0 sm:h-9">
          <UserRoundPlus />
          {inProgress ? "Adding…" : unlockFirst ? "Unlock to add" : "Add"}
        </Button>
      </div>
      <div id={hintId} className="grid gap-0.5 text-xs text-pretty">
        {error !== "" ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <p role={fault ? "alert" : undefined} className={fault ? "text-destructive" : "text-muted-foreground"}>
            {plan.state === "invalid" && !tried ? "Keep typing: an email, or a domain with its @." : plan.hint}
          </p>
        )}
        {plan.state === "ready" && plan.limit !== null && <p className="text-muted-foreground">{plan.limit}</p>}
        {plan.state === "ready" && plan.password && <p className="text-muted-foreground tabular-nums">{plannedEnd(fromChoice(duration), now)}</p>}
        {unlockFirst && (
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
  onRole,
  onRemove,
}: {
  row: EntryRow
  slug: string
  busy: boolean
  onRole: (role: AccessRole) => void
  onRemove: () => void
}) {
  const { entry } = row
  return (
    <li className={LINE}>
      <div className="grid min-w-0 gap-0.5">
        <span className="font-medium wrap-anywhere">
          {entry.who}
          {row.self && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        {row.what !== null && (
          <span className={cn("text-xs", row.whatTone === "attention" ? TONE_TEXT.attention : "text-muted-foreground")}>{row.what}</span>
        )}
        <span className="text-xs text-muted-foreground">{row.added}</span>
      </div>
      <div className="flex items-center gap-1">
        {row.roles === null ? (
          <span className={cn(ROLE_WIDTH, "px-2.5 text-sm text-secondary-foreground")}>{roleLabel(entry.role)}</span>
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
          <span aria-hidden="true" className="size-8 max-md:size-10" />
        )}
      </div>
    </li>
  )
}

/** Someone who is on no list of this project and has access all the same: the owner, the server's own emails. */
function FixedLine({ who, detail, label }: { who: string; detail: string; label: string }) {
  return (
    <li className={LINE}>
      <div className="grid min-w-0 gap-0.5">
        <span className="font-medium wrap-anywhere">{who}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className={cn(ROLE_WIDTH, "px-2.5 text-sm text-secondary-foreground")}>{label}</span>
        <span aria-hidden="true" className="size-8 max-md:size-10" />
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
              <DialogTitle className="pr-8 leading-snug wrap-anywhere">Password access for {created.who}</DialogTitle>
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

/**
 * The project's people with access. `page` is the steward's answer to
 * `/api/access`; `onChanged` reads it again after each change.
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
  const [removing, setRemoving] = useState<{ entry: EntryView | null; open: boolean; inProgress: boolean; error: string }>({
    entry: null,
    open: false,
    inProgress: false,
    error: "",
  })

  const manages = page.grantable.length > 0
  const entries = sortEntries(page.entries)
  const listed = new Set(entries.map((entry) => entry.who))
  const always = page.signIn.admins.filter((email) => !listed.has(email))

  async function changeRole(entry: EntryView, role: AccessRole) {
    if (role === entry.role) return
    setRowError("")
    if (raiseNeedsUnlock(entry.role, role) && !actions.state.open) return actions.unlock()
    setBusy(entry.who)
    try {
      const { status, body } = await putAccess(page.slug, entry.who, role)
      if (status === 200 && body !== null) {
        announce(`${entry.who} is now ${roleLabel(role)} on ${page.slug}.`)
        return onChanged()
      }
      const message = actions.refusal(refusalOf(status, body))
      if (message !== null) setRowError(`${entry.who}: ${message}`)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    const entry = removing.entry
    if (entry === null) return
    setRemoving((previous) => ({ ...previous, inProgress: true, error: "" }))
    const { status, body } = await removeAccess(page.slug, entry.who)
    if (status === 200) {
      setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
      announce(`${entry.who} no longer has access to ${page.slug}.`)
      if (notice?.who === entry.who) setNotice(null)
      return onChanged()
    }
    const message = actions.refusal(refusalOf(status, body))
    if (message === null) return setRemoving((previous) => ({ ...previous, open: false, inProgress: false }))
    setRemoving((previous) => ({ ...previous, inProgress: false, error: message }))
  }

  const count = entries.length

  return (
    <Panel title="People with access" count={count > 0 ? count : undefined} description={inertNote(page.slug, general) ?? undefined} full>
      {manages && (
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
              announce(`${entry.who} added as ${roleLabel(entry.role)}.`)
            }
            onChanged()
          }}
        />
      )}
      {notice !== null && <SendNotice notice={notice} onClose={() => setNotice(null)} />}
      {rowError !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{rowError}</Banner>
        </div>
      )}

      <ul className="divide-y divide-divider" aria-label={`Who has access to ${page.slug}`}>
        <FixedLine who="Owner" detail="Signs in with the dashboard's password" label={OWNER_TEXT.label} />
        {entries.map((entry) => (
          <EntryLine
            key={entry.who}
            row={entryRow(entry, page, now)}
            slug={page.slug}
            busy={busy === entry.who}
            onRole={(role) => void changeRole(entry, role)}
            onRemove={() => setRemoving({ entry, open: true, inProgress: false, error: "" })}
          />
        ))}
        {always.map((email) => (
          <FixedLine key={email} who={email} detail="Opens every restricted site: set on the server by the owner" label="Can open" />
        ))}
      </ul>

      {count === 0 && (
        <EmptyState compact title={`Nobody else has access to ${page.slug} yet`}>
          {manages
            ? "Add people above: they open the site when its access is restricted, and with a role they see or manage it here."
            : `Only the owner can open ${page.slug} when its access is restricted.`}
        </EmptyState>
      )}

      <PasswordDialog created={created} url={page.url} onClose={() => setCreated(null)} />

      <AlertDialog
        open={removing.open}
        onOpenChange={(next) => {
          if (!next && !removing.inProgress) setRemoving((previous) => ({ ...previous, open: false }))
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-left max-sm:place-items-start">
            <AlertDialogTitle className="wrap-anywhere">
              Remove {removing.entry?.who} from {page.slug}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {removing.entry?.kind === "domain"
                ? `Everyone at ${removing.entry.who.slice(1)} loses access at their next request, except the people added by name.`
                : removing.entry?.kind === "password"
                  ? "Their password stops opening the site at their next request."
                  : `They lose access to ${page.slug} at their next request, on the site and in the dashboard.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing.error !== "" && <Banner tone="error">{removing.error}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing.inProgress} onClick={() => void remove()} className="max-sm:h-11">
              {removing.inProgress ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}

/**
 * What each role can do, from the lowest: the ladder a newcomer reads once,
 * with their own rung marked.
 */
export function RolesPanel({ yours }: { yours: AccessRole | "owner" | null }) {
  const rungs: { key: AccessRole | "owner"; text: RoleText }[] = [
    ...(Object.keys(ROLE_TEXTS) as AccessRole[]).map((role) => ({ key: role, text: ROLE_TEXTS[role] })),
    { key: "owner" as const, text: OWNER_TEXT },
  ]
  return (
    <Panel title="What each role can do" full>
      <dl className="divide-y divide-divider">
        {rungs.map(({ key, text }) => (
          <div key={key} className={cn("grid gap-0.5 px-4 py-2.5", key === yours && "shadow-[inset_2px_0_0_var(--primary)]")}>
            <dt className="flex items-center gap-2 font-medium">
              {text.label}
              {key === yours && <span className="text-xs font-normal text-muted-foreground">Your role</span>}
            </dt>
            <dd className="text-xs text-pretty text-muted-foreground">{text.can}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
