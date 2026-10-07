import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { History, KeyRound, Pencil, Plug, Plus, Trash2 } from "lucide-react"
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
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Command, useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { Banner, EmptyState, ErrorState, INPUT_DIALOG, PageBody, PageHeader, Panel, RowsSkeleton, Status } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import {
  activityLine,
  grantRows,
  grantWords,
  putConnector,
  readConnectors,
  readConnectorsActivity,
  refusalField,
  removeConnector,
  setGrant,
  type ConnectorField,
  type GrantRow,
} from "@/lib/connectors"
import { ABSENT, ago, dateTime } from "@/lib/format"
import { siteUrl } from "@/lib/pages"
import { refusalOf } from "@/lib/secrets"
import type { ConnectorView, ConnectorsView, EgressAuditRow, EgressStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The Connectors page: the credentials this server lends to projects without
 * handing them over, who asks for which, who has been granted which, and what
 * the egress proxy did with them.
 *
 * Every write goes through the steward under the secrets' unlock, the lock in
 * the header being the same one. A value is typed once, sent once, and never
 * shown: there is no Reveal here, as for a write-only secret file.
 */

type ListState =
  | { state: "loading" }
  | { state: "error"; message: string; stewardOutdated: boolean }
  | { state: "ready"; view: ConnectorsView }

type ActivityState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: EgressAuditRow[]; status: EgressStatus }

type Editing = { open: boolean; opening: number; connector: ConnectorView | null }
type Removal = { open: boolean; opening: number; connector: ConnectorView | null }

/** The proxy records a change within five seconds of seeing it: the activity is read again after that. */
const ACTIVITY_AFTER_WRITE_MS = 6_000

function isView(body: unknown): body is ConnectorsView {
  return typeof body === "object" && body !== null && Array.isArray((body as ConnectorsView).connectors) && Array.isArray((body as ConnectorsView).grants)
}

function When({ at, serverNow }: { at: number | null; serverNow: number }) {
  if (at === null) return <span className="text-muted-foreground">{ABSENT}</span>
  return (
    <time dateTime={new Date(at).toISOString()} title={dateTime(at)} className="whitespace-nowrap text-muted-foreground tabular-nums">
      {ago(serverNow - at)}
    </time>
  )
}

function SiteLink({ slug, known }: { slug: string | null; known: ReadonlySet<string> }) {
  if (slug === null) return null
  if (!known.has(slug)) return <span>{slug}</span>
  return (
    <InternalLink
      href={siteUrl(slug)}
      className="rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {slug}
    </InternalLink>
  )
}

/** A form field: label, control, help, error under the field. */
function Field({ id, label, help, error, children }: { id: string; label: string; help: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  )
}

// --- The dialogs -------------------------------------------------------------------

/**
 * Add a connector, or change one: its address, its header, and its value only
 * if a new one is typed. Remounted on every opening, so that a value typed and
 * abandoned is gone the next time.
 */
function ConnectorDialog({
  editing,
  onClose,
  onSaved,
  onLocked,
  focusReturn,
}: {
  editing: Editing
  onClose: () => void
  onSaved: (view: ConnectorsView, name: string, created: boolean) => void
  onLocked: () => void
  focusReturn: () => HTMLElement | boolean
}) {
  const { sessionExpired } = useData()
  const existing = editing.connector
  const [name, setName] = useState(existing?.name ?? "")
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "https://")
  const [header, setHeader] = useState(existing?.header ?? "Authorization")
  const [value, setValue] = useState("")
  const [errors, setErrors] = useState<Partial<Record<ConnectorField, string>>>({})
  const [formError, setFormError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const fields = { name: useRef<HTMLInputElement>(null), baseUrl: useRef<HTMLInputElement>(null), header: useRef<HTMLInputElement>(null), value: useRef<HTMLInputElement>(null) }
  const ids = { name: useId(), baseUrl: useId(), header: useId(), value: useId() }
  const describedby = (field: ConnectorField) => (errors[field] !== undefined ? `${ids[field]}-error` : `${ids[field]}-help`)

  async function save(event: SyntheticEvent) {
    event.preventDefault()
    if (inProgress) return
    setErrors({})
    setFormError("")
    setInProgress(true)
    try {
      const { status, body } = await putConnector({ name, baseUrl, header, value: value === "" && existing !== null ? null : value })
      if (status === 200 && isView(body)) {
        setValue("")
        return onSaved(body, name, existing === null)
      }
      const refusal = refusalOf(status, body)
      if (refusal.kind === "session") {
        onClose()
        return sessionExpired()
      }
      if (refusal.kind === "locked") {
        onClose()
        return onLocked()
      }
      const { field, message } = refusalField(refusal.message)
      if (field === null) return setFormError(message)
      setErrors({ [field]: message })
      fields[field].current?.focus()
    } finally {
      setInProgress(false)
    }
  }

  return (
    <Dialog
      open={editing.open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <DialogContent
        className={cn("gap-5 sm:max-w-md", INPUT_DIALOG)}
        finalFocus={focusReturn}
        initialFocus={() => (existing === null ? fields.name.current : fields.baseUrl.current)}
      >
        <form noValidate onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">{existing === null ? "Add connector" : `Change ${existing.name}`}</DialogTitle>
            <DialogDescription className="text-pretty">
              {existing === null
                ? "A credential projects use through the egress proxy, without ever seeing it. Only projects you grant it to, and whose sitesolide.json asks for it, can call it."
                : "Projects using it pick up the change at their next call."}
            </DialogDescription>
          </DialogHeader>

          <Field id={ids.name} label="Name" error={errors.name} help="Lowercase letters, digits and dashes. A project asks for it by this name.">
            <Input
              ref={fields.name}
              id={ids.name}
              value={name}
              disabled={existing !== null}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name !== undefined || undefined}
              aria-describedby={describedby("name")}
              className="h-10 font-mono sm:h-9"
            />
          </Field>

          <Field id={ids.baseUrl} label="Base address" error={errors.baseUrl} help="HTTPS. Every call stays under this path.">
            <Input
              ref={fields.baseUrl}
              id={ids.baseUrl}
              value={baseUrl}
              type="url"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
              aria-invalid={errors.baseUrl !== undefined || undefined}
              aria-describedby={describedby("baseUrl")}
              className="h-10 sm:h-9"
            />
          </Field>

          <Field id={ids.header} label="Header" error={errors.header} help="The header that carries the credential.">
            <Input
              ref={fields.header}
              id={ids.header}
              value={header}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setHeader(event.target.value)}
              aria-invalid={errors.header !== undefined || undefined}
              aria-describedby={describedby("header")}
              className="h-10 font-mono sm:h-9"
            />
          </Field>

          <Field
            id={ids.value}
            label="Value"
            error={errors.value}
            help={existing === null ? "The whole header value, the word Bearer included when the API wants it. It can't be shown again." : "Leave empty to keep the current value. It can't be shown again."}
          >
            <Input
              ref={fields.value}
              id={ids.value}
              value={value}
              type="password"
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={errors.value !== undefined || undefined}
              aria-describedby={describedby("value")}
              className="h-10 font-mono sm:h-9"
            />
          </Field>

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
              {inProgress ? "Saving…" : existing === null ? "Add connector" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The removal: every project using it loses it at once, so the name is retyped. */
function RemoveDialog({
  removal,
  onClose,
  onRemoved,
  onLocked,
  focusReturn,
}: {
  removal: Removal
  onClose: () => void
  onRemoved: (view: ConnectorsView, name: string) => void
  onLocked: () => void
  focusReturn: () => HTMLElement | boolean
}) {
  const { sessionExpired } = useData()
  const [typed, setTyped] = useState("")
  const [error, setError] = useState("")
  const [inProgress, setInProgress] = useState(false)
  const id = useId()
  const name = removal.connector?.name ?? ""

  async function confirm() {
    if (inProgress) return
    setError("")
    setInProgress(true)
    try {
      const { status, body } = await removeConnector({ name, confirmation: typed })
      if (status === 200 && isView(body)) return onRemoved(body, name)
      const refusal = refusalOf(status, body)
      if (refusal.kind === "session") {
        onClose()
        return sessionExpired()
      }
      if (refusal.kind === "locked") {
        onClose()
        return onLocked()
      }
      setError(refusal.message)
    } finally {
      setInProgress(false)
    }
  }

  return (
    <AlertDialog
      open={removal.open}
      onOpenChange={(next) => {
        if (!next && !inProgress) onClose()
      }}
    >
      <AlertDialogContent finalFocus={focusReturn}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            Every project granted {name} loses it at its next call, and its grants are removed. The credential stays valid at its
            provider: revoke it there too.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={id}>Type {name} to confirm</Label>
          <Input
            id={id}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            className="h-10 font-mono sm:h-9"
          />
        </div>
        {error !== "" && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={inProgress} className="max-sm:h-10">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={inProgress || typed !== name} onClick={() => void confirm()} className="max-sm:h-10">
            {inProgress ? "Removing…" : "Remove connector"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// --- The panels --------------------------------------------------------------------

function ConnectorsPanel({
  view,
  serverNow,
  canWrite,
  onAdd,
  onEdit,
  onRemove,
}: {
  view: ConnectorsView
  serverNow: number
  canWrite: boolean
  onAdd: () => void
  onEdit: (connector: ConnectorView) => void
  onRemove: (connector: ConnectorView) => void
}) {
  const used = (name: string) => view.grants.filter((grant) => grant.connector === name).length
  return (
    <Panel
      title="Connectors"
      count={view.connectors.length}
      full
      actions={
        canWrite ? (
          <Button variant="outline" size="sm" onClick={onAdd} className="max-md:h-10">
            <Plus />
            Add connector
          </Button>
        ) : undefined
      }
    >
      {view.connectors.length === 0 ? (
        <EmptyState icon={Plug} title="No connectors yet" compact>
          Add one to lend a credential to a project without putting it in its code, its repository or its environment.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-divider">
          {view.connectors.map((connector) => {
            const grants = used(connector.name)
            const changed = Date.parse(connector.updatedAt)
            return (
              <li key={connector.name} className="@container flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="grid min-w-0 flex-1 basis-64 gap-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <h3 className="font-mono text-[0.8125rem] font-semibold wrap-anywhere">{connector.name}</h3>
                    <Status tone="neutral" title="Replaced, never read back" className="text-muted-foreground">
                      Write-only
                    </Status>
                  </div>
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    {connector.baseUrl}, header <code className="font-mono">{connector.header}</code>,{" "}
                    {grants === 0 ? "granted to no project" : `granted to ${grants} project${grants === 1 ? "" : "s"}`}
                    {Number.isNaN(changed) ? "" : `, changed ${ago(serverNow - changed)}`}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => onEdit(connector)} className="max-md:h-10">
                      <Pencil />
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemove(connector)}
                      className="text-muted-foreground hover:text-foreground max-md:h-10"
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function GrantsPanel({
  view,
  known,
  canWrite,
  inFlight,
  error,
  onToggle,
}: {
  view: ConnectorsView
  known: ReadonlySet<string>
  canWrite: boolean
  inFlight: string | null
  error: string
  onToggle: (row: GrantRow) => void
}) {
  const rows = grantRows(view)
  const caption = "Who asks for which connector, and who has been granted it, what needs a decision first"
  const action = (row: GrantRow) => {
    const words = grantWords(row)
    if (!canWrite || words.action === null) return null
    const key = `${row.slug}/${row.connector}`
    const busy = inFlight === key
    return (
      <Button
        variant={words.action === "grant" ? "outline" : "ghost"}
        size="sm"
        disabled={inFlight !== null}
        onClick={() => onToggle(row)}
        className={cn("max-md:h-10", words.action === "withdraw" && "text-muted-foreground hover:text-foreground")}
      >
        {words.action === "grant" ? (busy ? "Granting…" : "Grant") : busy ? "Withdrawing…" : "Withdraw"}
      </Button>
    )
  }

  return (
    <Panel
      title="Grants"
      count={view.grants.length}
      description="A project gets a connector when its sitesolide.json asks for it under connectors and you grant it here. Either alone lends nothing."
      full
    >
      {error !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={Plug} title="No project asks for a connector" compact>
          A project asks with <code className="font-mono text-xs">"connectors": ["slack"]</code> in its sitesolide.json, then{" "}
          <code className="font-mono text-xs">sitesolide deploy</code>.
        </EmptyState>
      ) : (
        <div className="@container">
          <table className="hidden w-full text-sm @2xl:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="h-10 border-b bg-muted text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 pl-4 font-medium">
                  Site
                </th>
                <th scope="col" className="px-3 font-medium">
                  Connector
                </th>
                <th scope="col" className="px-3 font-medium">
                  State
                </th>
                <th scope="col" className="px-3 pr-4 text-right font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {rows.map((row) => {
                const words = grantWords(row)
                return (
                  <tr key={`${row.slug}/${row.connector}`}>
                    <td className="px-3 py-3 pl-4">
                      <SiteLink slug={row.slug} known={known} />
                    </td>
                    <td className="px-3 py-3">
                      <code className="font-mono text-[0.8125rem]">{row.connector}</code>
                    </td>
                    <td className="px-3 py-3">
                      <Status tone={words.tone} title={words.help}>
                        {words.word}
                      </Status>
                      <span className="sr-only">. {words.help}</span>
                    </td>
                    <td className="px-3 py-1.5 pr-4 text-right">{action(row)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ul aria-label={caption} className="divide-y divide-divider @2xl:hidden">
            {rows.map((row) => {
              const words = grantWords(row)
              return (
                <li key={`${row.slug}/${row.connector}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="grid min-w-0 flex-1 basis-48 gap-1">
                    <span className="text-sm">
                      <code className="font-mono text-[0.8125rem]">{row.connector}</code> <span className="text-muted-foreground">for</span>{" "}
                      <SiteLink slug={row.slug} known={known} />
                    </span>
                    <span className="text-xs">
                      <Status tone={words.tone}>{words.word}</Status>
                    </span>
                    <span className="text-xs text-muted-foreground">{words.help}</span>
                  </div>
                  {action(row)}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Panel>
  )
}

function ActivityPanel({
  activity,
  known,
  serverNow,
  onRetry,
  retrying,
}: {
  activity: ActivityState
  known: ReadonlySet<string>
  serverNow: number
  onRetry: () => void
  retrying: boolean
}) {
  const caption = "The egress proxy's latest refusals, connector uses and changes, most recent first"
  return (
    <Panel title="Egress activity" description="From the egress proxy itself, counted by the minute. Values never appear here." full>
      {activity.state === "loading" && (
        <div aria-busy="true" aria-label="Loading activity">
          <RowsSkeleton lines={4} />
        </div>
      )}
      {activity.state === "error" && (
        <ErrorState title={activity.message} onRetry={onRetry} inProgress={retrying} compact>
          <span className="grid justify-items-center gap-2">
            Check that it runs, on the server:
            <Command text="sudo systemctl status sitesolide-egress" />
          </span>
        </ErrorState>
      )}
      {activity.state === "ready" && activity.rows.length === 0 && (
        <EmptyState icon={History} title="No egress activity yet" compact>
          Refused destinations, connector calls and changes show up here, within a minute.
        </EmptyState>
      )}
      {activity.state === "ready" && activity.rows.length > 0 && (
        <div className="@container">
          <table className="hidden w-full text-sm @2xl:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="h-10 border-b bg-muted text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 pl-4 font-medium">
                  What
                </th>
                <th scope="col" className="px-3 font-medium">
                  Site
                </th>
                <th scope="col" className="px-3 pr-4 text-right font-medium">
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {activity.rows.map((row) => {
                const line = activityLine(row)
                return (
                  <tr key={row.id}>
                    <td className="px-3 py-3 pl-4">
                      <div className="grid gap-0.5">
                        {line.tone === "attention" ? <Status tone="attention">{line.summary}</Status> : <span className="wrap-anywhere">{line.summary}</span>}
                        {line.detail !== null && <span className="text-xs text-muted-foreground wrap-anywhere">{line.detail}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <SiteLink slug={line.site} known={known} />
                    </td>
                    <td className="px-3 py-3 pr-4 text-right">
                      <When at={line.at} serverNow={serverNow} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ol aria-label={caption} className="divide-y divide-divider @2xl:hidden">
            {activity.rows.map((row) => {
              const line = activityLine(row)
              return (
                <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                  <span className="text-sm wrap-anywhere">
                    {line.tone === "attention" ? <Status tone="attention">{line.summary}</Status> : line.summary}
                  </span>
                  <span className="text-xs">
                    <When at={line.at} serverNow={serverNow} />
                  </span>
                  {(line.site !== null || line.detail !== null) && (
                    <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <SiteLink slug={line.site} known={known} />
                      {line.detail !== null && <span className="wrap-anywhere">{line.detail}</span>}
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Panel>
  )
}

// --- The page ----------------------------------------------------------------------

export function ConnectorsPage() {
  const { generation, snapshot, secrets, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const [list, setList] = useState<ListState>({ state: "loading" })
  const [activity, setActivity] = useState<ActivityState>({ state: "loading" })
  const [retrying, setRetrying] = useState(false)
  const [editing, setEditing] = useState<Editing>({ open: false, opening: 0, connector: null })
  const [removal, setRemoval] = useState<Removal>({ open: false, opening: 0, connector: null })
  const [grantInFlight, setGrantInFlight] = useState<string | null>(null)
  const [grantError, setGrantError] = useState("")
  const origin = useRef<HTMLElement | null>(null)
  const later = useRef<number | null>(null)

  const load = useCallback(async () => {
    const { status, body } = await readConnectors()
    if (status === 200 && isView(body)) return setList({ state: "ready", view: body })
    const refusal = refusalOf(status, body)
    if (refusal.kind === "session") return sessionExpired()
    const message = refusal.kind === "locked" ? "Unlock to see the connectors." : refusal.message
    const stewardOutdated = status === 404 && message.includes("predates connectors")
    // A failed re-read keeps the list already there.
    setList((before) => (before.state === "ready" ? before : { state: "error", message, stewardOutdated }))
  }, [sessionExpired])

  const loadActivity = useCallback(async () => {
    const { status, body } = await readConnectorsActivity()
    if (status === 200 && body !== null && Array.isArray(body.rows) && typeof body.status === "object" && body.status !== null) {
      return setActivity({ state: "ready", rows: body.rows, status: body.status })
    }
    if (status === 401) return sessionExpired()
    const message = typeof body?.message === "string" && body.message !== "" ? body.message : "Can't reach the egress proxy."
    setActivity((before) => (before.state === "ready" ? before : { state: "error", message }))
  }, [sessionExpired])

  useEffect(() => {
    void load()
    void loadActivity()
  }, [generation, load, loadActivity])

  useEffect(() => () => {
    if (later.current !== null) window.clearTimeout(later.current)
  }, [])

  function rememberOrigin() {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const focusReturn = () => {
    const element = origin.current
    return element !== null && element.isConnected && element.getClientRects().length > 0 ? element : true
  }

  /** After a write: the view the steward answered, and the activity once the proxy has seen it. */
  function written(view: ConnectorsView, message: string) {
    setList({ state: "ready", view })
    announce(message)
    if (later.current !== null) window.clearTimeout(later.current)
    later.current = window.setTimeout(() => void loadActivity(), ACTIVITY_AFTER_WRITE_MS)
  }

  /** A write that met the lock: the password, without replaying the action. */
  function locked() {
    secrets.setUnlockedUntil(null)
    actions.unlock()
  }

  async function toggle(row: GrantRow) {
    if (!actions.state.open) return locked()
    const words = grantWords(row)
    const granted = words.action === "grant"
    setGrantError("")
    setGrantInFlight(`${row.slug}/${row.connector}`)
    try {
      const { status, body } = await setGrant({ slug: row.slug, connector: row.connector, granted })
      if (status === 200 && isView(body)) {
        return written(body, granted ? `${row.connector} granted to ${row.slug}.` : `${row.connector} withdrawn from ${row.slug}.`)
      }
      const refusal = refusalOf(status, body)
      if (refusal.kind === "session") return sessionExpired()
      if (refusal.kind === "locked") return locked()
      setGrantError(refusal.message)
    } finally {
      setGrantInFlight(null)
    }
  }

  async function retry() {
    setRetrying(true)
    try {
      await Promise.all([load(), loadActivity()])
    } finally {
      setRetrying(false)
    }
  }

  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const ready = list.state === "ready" ? list.view : null
  const writable = ready !== null && ready.installed && ready.state === "managed"
  const canWrite = writable && actions.state.open
  // No lock until something has been read: a steward that does not answer would refuse.
  const headerActions = secrets.projects === null ? undefined : <SecretsLockControl />

  return (
    <>
      <PageHeader title="Connectors" actions={headerActions} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Credentials this server lends to projects without handing them over. A project calls the egress proxy, which adds the
          credential on the way out: it never appears in the project's code, repository or environment.
        </p>

        {list.state === "loading" && (
          <div aria-busy="true" aria-label="Loading connectors" className="overflow-hidden rounded-xl border bg-card">
            <RowsSkeleton lines={3} />
          </div>
        )}

        {list.state === "error" &&
          (list.stewardOutdated ? (
            <Banner tone="attention" action={<Command text="bin/deploy-steward.sh" />}>
              The steward on the server predates connectors. Update it from your workstation.
            </Banner>
          ) : (
            <ErrorState title={list.message} onRetry={() => void retry()} inProgress={retrying} />
          ))}

        {ready !== null && !ready.installed && (
          <Banner tone="attention" action={<Command text="bin/deploy-egress.sh" />}>
            The egress proxy isn't installed on this server, so nothing can be lent yet. Install it from your workstation, then run{" "}
            <code className="font-mono text-xs">bin/deploy-steward.sh</code>.
          </Banner>
        )}
        {ready !== null && ready.installed && ready.state === "unmanaged" && (
          <Banner tone="error">
            The connectors aren't managed here: {ready.reason}. Nothing is written until the files are repaired on the server.
          </Banner>
        )}
        {writable && !actions.state.open && (
          <p className="text-sm text-muted-foreground">Unlock to add, change or grant connectors.</p>
        )}

        {ready !== null && (
          <>
            <ConnectorsPanel
              view={ready}
              serverNow={actions.serverNow}
              canWrite={canWrite}
              onAdd={() => {
                rememberOrigin()
                setEditing((before) => ({ open: true, opening: before.opening + 1, connector: null }))
              }}
              onEdit={(connector) => {
                rememberOrigin()
                setEditing((before) => ({ open: true, opening: before.opening + 1, connector }))
              }}
              onRemove={(connector) => {
                rememberOrigin()
                setRemoval((before) => ({ open: true, opening: before.opening + 1, connector }))
              }}
            />
            <GrantsPanel
              view={ready}
              known={known}
              canWrite={canWrite}
              inFlight={grantInFlight}
              error={grantError}
              onToggle={(row) => void toggle(row)}
            />
          </>
        )}

        <ActivityPanel activity={activity} known={known} serverNow={actions.serverNow} onRetry={() => void retry()} retrying={retrying} />
      </PageBody>

      <ConnectorDialog
        key={editing.opening}
        editing={editing}
        onClose={() => setEditing((before) => ({ ...before, open: false }))}
        onSaved={(view, name, created) => {
          setEditing((before) => ({ ...before, open: false }))
          written(view, created ? `Connector ${name} added.` : `Connector ${name} saved.`)
        }}
        onLocked={locked}
        focusReturn={focusReturn}
      />
      <RemoveDialog
        key={removal.opening}
        removal={removal}
        onClose={() => setRemoval((before) => ({ ...before, open: false }))}
        onRemoved={(view, name) => {
          setRemoval((before) => ({ ...before, open: false }))
          written(view, `Connector ${name} removed.`)
        }}
        onLocked={locked}
        focusReturn={focusReturn}
      />
    </>
  )
}
