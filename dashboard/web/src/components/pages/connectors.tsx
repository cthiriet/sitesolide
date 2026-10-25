import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { History, Pencil, Plug, Plus, Trash2 } from "lucide-react"
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
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Command, useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { CellText, DataTable, RowButton, RowMenu, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetSection, useSheet } from "@/components/detail-sheet"
import { FilterBar, useListState } from "@/components/filter-bar"
import { TEXT_LINK } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import {
  Banner,
  Count,
  ErrorState,
  FormError,
  INPUT_DIALOG,
  InlineEmpty,
  PageBody,
  PageHeader,
  Panel,
  RowsSkeleton,
  StateLabel,
  When,
  useRetry,
} from "@/components/page"
import { WriteButton, WriteMenuItem } from "@/components/unlock"
import { useSecretsActions } from "@/components/secrets-actions"
import { returnTo, type FocusReturn } from "@/components/secrets-dialogs"
import {
  activityLine,
  connectorPairs,
  connectorRows,
  grantSeverity,
  grantWords,
  grantedProjects,
  putConnector,
  readConnectors,
  readConnectorsActivity,
  refusalField,
  removeConnector,
  requestRows,
  setGrant,
  shortAddress,
  type ConnectorField,
  type GrantRow,
} from "@/lib/connectors"
import { ago, dateTime } from "@/lib/format"
import { RECENT_LINES, historyUrl } from "@/lib/history"
import { FILTER_BAR_FROM, type ListSpec } from "@/lib/list-state"
import { siteUrl } from "@/lib/pages"
import { normalize } from "@/lib/search"
import { refusalOf } from "@/lib/secrets"
import type { ConnectorView, ConnectorsView, EgressAuditRow } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The Connectors page: the credentials this server lends to projects without
 * handing them over. First what waits for the owner, the Requests, only while
 * something does; then the connectors, one line each, the projects each is
 * granted to and its recent calls in its sheet. What the egress proxy did is
 * in Activity, under History.
 *
 * Every write goes through the steward under the secrets' unlock, the same
 * one, asked for when a write is pressed. A value is typed once, sent once,
 * and never shown: there is no Reveal here.
 */

type ListState =
  | { state: "loading" }
  | { state: "error"; message: string; stewardOutdated: boolean }
  | { state: "ready"; view: ConnectorsView }

type ActivityState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: EgressAuditRow[] }

/** A connector's dialog, remounted on every opening; `connector` null adds one, with the `name` a project asks for when it came from a request. */
type Opened = { open: boolean; opening: number; connector: ConnectorView | null; name?: string }

/** The list's address: a search, from ten connectors. */
const SPEC: ListSpec = {}

/** The proxy records a change within five seconds of seeing it: the activity is read again after that. */
const ACTIVITY_AFTER_WRITE_MS = 6_000

function isView(body: unknown): body is ConnectorsView {
  return typeof body === "object" && body !== null && Array.isArray((body as ConnectorsView).connectors) && Array.isArray((body as ConnectorsView).grants)
}

function SiteLink({ slug, known }: { slug: string | null; known: ReadonlySet<string> }) {
  if (slug === null) return null
  if (!known.has(slug)) return <span>{slug}</span>
  return (
    <InternalLink href={siteUrl(slug)} className={TEXT_LINK}>
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
  editing: Opened
  onClose: () => void
  onSaved: (view: ConnectorsView, name: string, created: boolean) => void
  onLocked: () => void
  focusReturn: FocusReturn
}) {
  const { sessionExpired } = useData()
  const existing = editing.connector
  const [name, setName] = useState(existing?.name ?? editing.name ?? "")
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
        initialFocus={() => (existing === null && editing.name === undefined ? fields.name.current : fields.baseUrl.current)}
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

          <FormError>{formError}</FormError>

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
  removal: Opened
  onClose: () => void
  onRemoved: (view: ConnectorsView, name: string) => void
  onLocked: () => void
  focusReturn: FocusReturn
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
        <FormError>{error}</FormError>
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

// --- Requests ---------------------------------------------------------------------

/**
 * What waits for the owner, first on the page and only while something does:
 * a project that asks for a connector not granted, one that asks for a
 * connector this server lacks, a grant left to a site that is gone. Each with
 * its one action. Its count is its rows'.
 */
function RequestsPanel({
  rows,
  known,
  canWrite,
  inFlight,
  error,
  onToggle,
  onAdd,
}: {
  rows: readonly GrantRow[]
  known: ReadonlySet<string>
  canWrite: boolean
  inFlight: string | null
  error: string
  onToggle: (row: GrantRow) => void
  onAdd: (name: string) => void
}) {
  const columns: Column<GrantRow>[] = [
    {
      key: "connector",
      head: "Connector",
      width: "minmax(120px,0.8fr)",
      slot: "primary",
      cell: (row) => <span className="truncate font-mono text-[0.8125rem] font-medium text-strong">{row.connector}</span>,
    },
    {
      key: "site",
      head: "Project",
      width: "minmax(140px,1fr)",
      slot: "meta",
      cell: (row) => <SiteLink slug={row.slug} known={known} />,
    },
    {
      key: "state",
      head: "State",
      width: "minmax(170px,1.2fr)",
      slot: "state",
      cell: (row) => {
        const words = grantWords(row)
        return (
          <>
            <StateLabel tone={words.tone} title={words.help}>
              {words.word}
            </StateLabel>
            <span className="sr-only">. {words.help}</span>
          </>
        )
      },
    },
    {
      key: "action",
      head: "",
      srHead: "Action",
      // Room for "Add connector" and its lock glyph.
      width: "172px",
      align: "end",
      slot: "time",
      cell: (row) => <GrantAction row={row} canWrite={canWrite} inFlight={inFlight} onToggle={onToggle} onAdd={onAdd} />,
    },
  ]
  return (
    <Panel title="Requests" count={rows.length} full>
      {error !== "" && (
        <div className="border-b p-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <DataTable
        label="Requests"
        caption="What waits for a decision: a removed site still granted first, then what projects ask for"
        rows={rows}
        rowKey={(row) => `${row.slug}/${row.connector}`}
        columns={columns}
        severity={(row) => grantSeverity(row.state)}
      />
    </Panel>
  )
}

/** A pair's one action: Grant what is asked, Withdraw what is granted, Add the connector a project asks for and the server lacks. */
function GrantAction({
  row,
  canWrite,
  inFlight,
  onToggle,
  onAdd,
}: {
  row: GrantRow
  canWrite: boolean
  inFlight: string | null
  onToggle: (row: GrantRow) => void
  onAdd: (name: string) => void
}) {
  if (!canWrite) return null
  const words = grantWords(row)
  if (row.state === "missing") {
    return (
      <WriteButton variant="outline" size="sm" onPress={() => onAdd(row.connector)} purpose={`add ${row.connector}`} resume="Add connector" className="max-md:h-9">
        <Plus />
        Add connector
      </WriteButton>
    )
  }
  if (words.action === null) return null
  const busy = inFlight === `${row.slug}/${row.connector}`
  // A request's answer is a button; withdrawing a grant in service, in a sheet, a quiet one.
  const quiet = row.state === "granted" || row.state === "unasked"
  return (
    <WriteButton
      variant={quiet ? "ghost" : "outline"}
      size="sm"
      disabled={inFlight !== null}
      onPress={() => onToggle(row)}
      purpose={words.action === "grant" ? `grant ${row.connector} to ${row.slug}` : `withdraw ${row.connector} from ${row.slug}`}
      className={cn("max-md:h-9", quiet && "text-muted-foreground hover:text-foreground")}
    >
      {words.action === "grant" ? (busy ? "Granting…" : "Grant") : busy ? "Withdrawing…" : "Withdraw"}
    </WriteButton>
  )
}

// --- The connectors ---------------------------------------------------------------

/** The projects a connector is granted to, in its row: "cms, roster", one that does not ask for it muted. */
function ProjectsCell({ rows }: { rows: readonly GrantRow[] }) {
  if (rows.length === 0) return <span className="text-muted-foreground">None yet</span>
  const shown = rows.slice(0, 2)
  const all = rows.map((row) => (row.state === "unasked" ? `${row.slug} (not asked for)` : row.slug)).join(", ")
  return (
    <span title={all} className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        {shown.map((row, index) => (
          <span key={row.slug} className={cn(row.state === "unasked" && "text-muted-foreground")}>
            {index > 0 && <span className="text-muted-foreground">, </span>}
            {row.slug}
          </span>
        ))}
      </span>
      {rows.length > shown.length && (
        <span className="shrink-0">
          <Count className="h-[1.125rem] px-1 text-[0.6875rem]">+{rows.length - shown.length}</Count>
          <span className="sr-only">: {all}</span>
        </span>
      )}
    </span>
  )
}

function connectorColumns(view: ConnectorsView, serverNow: number, open: (connector: ConnectorView) => void): Column<ConnectorView>[] {
  return [
    {
      key: "name",
      head: "Connector",
      width: "minmax(140px,1fr)",
      slot: "primary",
      cell: (connector) => (
        <RowButton onClick={() => open(connector)} className="font-mono text-[0.8125rem]">
          {connector.name}
        </RowButton>
      ),
    },
    {
      key: "address",
      head: "Base address",
      width: "minmax(200px,1.6fr)",
      slot: "meta",
      cell: (connector) => (
        <CellText title={connector.baseUrl} className="font-mono text-[0.8125rem] text-muted-foreground max-md:text-xs">
          {shortAddress(connector.baseUrl)}
        </CellText>
      ),
    },
    {
      key: "projects",
      head: "Projects",
      width: "minmax(140px,1fr)",
      // On two lines, top right: the address alone fills the second, cut rather than wrapped.
      slot: "state",
      cell: (connector) => <ProjectsCell rows={grantedProjects(view, connector.name)} />,
    },
    {
      key: "changed",
      head: "Changed",
      width: "96px",
      align: "end",
      slot: "hide",
      cell: (connector) => <When at={Date.parse(connector.updatedAt)} serverNow={serverNow} />,
    },
  ]
}

/** A connector's sheet: where it calls and with which header, the projects it concerns with their action, its recent calls. */
function ConnectorSheet({
  connector,
  view,
  known,
  serverNow,
  canWrite,
  inFlight,
  error,
  activity,
  onClose,
  onToggle,
  onEdit,
  onRemove,
}: {
  connector: ConnectorView | null
  view: ConnectorsView
  known: ReadonlySet<string>
  serverNow: number
  canWrite: boolean
  inFlight: string | null
  error: string
  activity: ActivityState
  onClose: () => void
  onToggle: (row: GrantRow) => void
  onEdit: (connector: ConnectorView) => void
  onRemove: (connector: ConnectorView) => void
}) {
  const changed = connector === null ? Number.NaN : Date.parse(connector.updatedAt)
  const pairs = connector === null ? [] : connectorPairs(view, connector.name)
  return (
    <DetailSheet
      open={connector !== null}
      onClose={onClose}
      title={connector?.name ?? ""}
      description="Write-only: its value is replaced, never read back."
      actions={
        connector !== null && canWrite ? (
          <WriteButton variant="outline" size="sm" onPress={() => onEdit(connector)} purpose={`change ${connector.name}`} resume="Change" className="max-md:h-10">
            <Pencil />
            Change
          </WriteButton>
        ) : undefined
      }
    >
      {connector !== null && (
        <>
          <SheetFacts
            facts={[
              { label: "Base address", value: <span className="font-mono text-[0.8125rem]">{connector.baseUrl}</span> },
              { label: "Header", value: <span className="font-mono text-[0.8125rem]">{connector.header}</span> },
              {
                label: "Changed",
                value: Number.isNaN(changed) ? "-" : (
                  <>
                    {dateTime(changed)} <span className="text-muted-foreground">({ago(serverNow - changed)})</span>
                  </>
                ),
              },
            ]}
          />

          <SheetSection title="Projects">
            {error !== "" && <Banner tone="error">{error}</Banner>}
            {pairs.length === 0 ? (
              <p className="text-pretty text-muted-foreground">
                Granted to no project yet. A project asks for it with <code className="font-mono text-xs">"connectors": ["{connector.name}"]</code> in
                its sitesolide.json.
              </p>
            ) : (
              <ul className="divide-y divide-divider">
                {pairs.map((row) => {
                  const words = grantWords(row)
                  return (
                    <li key={row.slug} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                      <span className="grid min-w-0 gap-0.5">
                        <SiteLink slug={row.slug} known={known} />
                        {row.state === "granted" ? (
                          <span className="text-xs text-muted-foreground">Granted, asked for</span>
                        ) : (
                          <StateLabel tone={words.tone} title={words.help} className="text-xs">
                            {words.word}
                          </StateLabel>
                        )}
                      </span>
                      <GrantAction row={row} canWrite={canWrite} inFlight={inFlight} onToggle={onToggle} onAdd={() => undefined} />
                    </li>
                  )
                })}
              </ul>
            )}
          </SheetSection>

          <ConnectorRecent name={connector.name} activity={activity} known={known} serverNow={serverNow} />

          {canWrite && (
            <div className="grid justify-items-start gap-2 border-t pt-4">
              <WriteButton
                variant="outline"
                onPress={() => onRemove(connector)}
                purpose={`remove ${connector.name}`}
                resume="Remove connector"
                className="text-destructive hover:text-destructive max-md:h-10"
              >
                <Trash2 />
                Remove connector
              </WriteButton>
            </div>
          )}
        </>
      )}
    </DetailSheet>
  )
}

/** The connector's last calls, changes, grants and refusals, from the egress proxy itself; then all of the proxy's in Activity. */
function ConnectorRecent({ name, activity, known, serverNow }: { name: string; activity: ActivityState; known: ReadonlySet<string>; serverNow: number }) {
  const rows = activity.state === "ready" ? connectorRows(activity.rows, name).slice(0, RECENT_LINES) : []
  return (
    <SheetSection
      title="Recent"
      action={
        <InternalLink href={historyUrl({ source: "egress" })} className={cn(TEXT_LINK, "text-xs text-muted-foreground")}>
          All activity
        </InternalLink>
      }
    >
      {activity.state === "idle" || activity.state === "loading" ? (
        <div aria-busy="true" aria-label="Loading recent activity" className="-mx-4">
          <RowsSkeleton lines={3} />
        </div>
      ) : activity.state === "error" ? (
        <InlineEmpty icon={History} className="-mx-4">
          {activity.message}
        </InlineEmpty>
      ) : rows.length === 0 ? (
        <InlineEmpty icon={History} className="-mx-4">
          Nothing yet.
        </InlineEmpty>
      ) : (
        <ol className="divide-y divide-divider">
          {rows.map((row) => {
            const line = activityLine(row)
            const meta = [line.site, line.detail].filter((part): part is string => part !== null && part !== "").join(" · ")
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2">
                <span className={cn("min-w-0 text-pretty", line.tone === "attention" && "font-medium text-attention-text")}>{line.summary}</span>
                <When at={line.at} serverNow={serverNow} />
                {meta !== "" && (
                  <span className="col-span-2 truncate text-xs text-muted-foreground">
                    {line.site !== null && known.has(line.site) ? (
                      <>
                        <InternalLink href={siteUrl(line.site)} className={TEXT_LINK}>
                          {line.site}
                        </InternalLink>
                        {line.detail !== null && ` · ${line.detail}`}
                      </>
                    ) : (
                      meta
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </SheetSection>
  )
}

// --- The page ----------------------------------------------------------------------

export function ConnectorsPage() {
  const { generation, snapshot, secrets, sessionExpired } = useData()
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const sheet = useSheet("connector")
  const search = useListState(SPEC)
  const [list, setList] = useState<ListState>({ state: "loading" })
  const [activity, setActivity] = useState<ActivityState>({ state: "idle" })
  const [editing, setEditing] = useState<Opened>({ open: false, opening: 0, connector: null })
  const [removal, setRemoval] = useState<Opened>({ open: false, opening: 0, connector: null })
  const [grantInFlight, setGrantInFlight] = useState<string | null>(null)
  const [grantError, setGrantError] = useState("")
  // The element a dialog was opened from, the page itself included when nothing had focus.
  const origin = useRef<HTMLElement | null>(null)
  const remember = () => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const focusReturn: FocusReturn = () => returnTo(origin.current)
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

  /** The proxy's own audit, read for a sheet: what one connector did lately. */
  const loadActivity = useCallback(async () => {
    setActivity((before) => (before.state === "ready" ? before : { state: "loading" }))
    const { status, body } = await readConnectorsActivity()
    if (status === 200 && body !== null && Array.isArray(body.rows)) return setActivity({ state: "ready", rows: body.rows })
    if (status === 401) return sessionExpired()
    const message = typeof body?.message === "string" && body.message !== "" ? body.message : "Can't reach the egress proxy."
    setActivity((before) => (before.state === "ready" ? before : { state: "error", message }))
  }, [sessionExpired])

  useEffect(() => {
    void load()
  }, [generation, load])

  // A sheet opened, by a click or by its address: the proxy's audit, once, then after each write.
  useEffect(() => {
    if (sheet.id !== null && activity.state === "idle") void loadActivity()
  }, [sheet.id, activity.state, loadActivity])

  useEffect(() => () => {
    if (later.current !== null) window.clearTimeout(later.current)
  }, [])

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

  /** Unlocked by then: `WriteButton` asked first. A lock met on the way asks again, without replaying. */
  async function toggle(row: GrantRow) {
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

  const { retrying, retry } = useRetry(load)

  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const ready = list.state === "ready" ? list.view : null
  // The writes are offered locked too: each asks for the unlock when pressed.
  const canWrite = ready !== null && ready.installed && ready.state === "managed"
  const requests = ready === null ? [] : requestRows(ready)
  const connectors = ready?.connectors ?? []
  const filterable = connectors.length >= FILTER_BAR_FROM
  const query = filterable ? normalize(search.query.trim()) : ""
  const shown = query === "" ? connectors : connectors.filter((connector) => normalize(`${connector.name} ${connector.baseUrl}`).includes(query))
  const opened = sheet.id === null ? null : (connectors.find((connector) => connector.name === sheet.id) ?? null)

  const add = (name?: string) => {
    remember()
    setEditing((before) => ({ open: true, opening: before.opening + 1, connector: null, name }))
  }
  const edit = (connector: ConnectorView) => {
    remember()
    setEditing((before) => ({ open: true, opening: before.opening + 1, connector }))
  }
  const askRemoval = (connector: ConnectorView) => {
    remember()
    setRemoval((before) => ({ open: true, opening: before.opening + 1, connector }))
  }

  return (
    <>
      <PageHeader
        title="Connectors"
        count={ready === null ? undefined : connectors.length}
        intro={
          <p>
            Credentials this server lends to projects without handing them over. A project calls the egress proxy, which adds
            the credential on the way out: it never appears in the project's code, repository or environment. A project gets
            one when its sitesolide.json asks for it under connectors and you grant it here; either alone lends nothing.
          </p>
        }
        actions={
          canWrite ? (
            <WriteButton onPress={() => add()} purpose="add a connector" resume="Add connector" className="max-md:h-10">
              <Plus />
              Add connector
            </WriteButton>
          ) : undefined
        }
        history={{ source: "egress" }}
      />
      <PageBody>
        {list.state === "loading" && (
          <div aria-busy="true" aria-label="Loading connectors" className="overflow-hidden rounded-xl border bg-card">
            <RowsSkeleton lines={3} />
          </div>
        )}

        {list.state === "error" &&
          (list.stewardOutdated ? (
            <Banner tone="attention" action={<Command text="sitesolide upgrade" />}>
              The steward on the server predates connectors. Bring it up to date from your workstation.
            </Banner>
          ) : (
            <Panel>
              <ErrorState title={list.message} onRetry={retry} inProgress={retrying} />
            </Panel>
          ))}

        {ready !== null && !ready.installed && (
          <Banner tone="attention" action={<Command text="sitesolide setup <user@host> --zone <zone> --email <address>" />}>
            The egress proxy isn't installed on this server, so nothing can be lent yet. Install it from your workstation: run{" "}
            <code className="font-mono text-xs">sitesolide setup</code> again for this server, without{" "}
            <code className="font-mono text-xs">--minimal</code>. It installs the proxy, then restarts the steward.
          </Banner>
        )}
        {ready !== null && ready.installed && ready.state === "unmanaged" && (
          <Banner tone="error">
            The connectors aren't managed here: {ready.reason}. Nothing is written until the files are repaired on the server.
          </Banner>
        )}

        {ready !== null && requests.length > 0 && (
          <RequestsPanel
            rows={requests}
            known={known}
            canWrite={canWrite}
            inFlight={grantInFlight}
            error={opened === null ? grantError : ""}
            onToggle={(row) => void toggle(row)}
            onAdd={add}
          />
        )}

        {ready !== null && (
          <div className="grid gap-3">
            {filterable && (
              <FilterBar list={search} shown={shown.length} total={connectors.length} noun={{ one: "connector", many: "connectors" }} search={{ label: "Search connectors" }} />
            )}
            <Panel full>
              <DataTable
                label="Connectors"
                caption="By name"
                rows={shown}
                rowKey={(connector) => connector.name}
                columns={connectorColumns(ready, actions.serverNow, (connector) => sheet.open(connector.name))}
                onRowClick={(connector) => sheet.open(connector.name)}
                selected={sheet.id}
                menu={
                  canWrite
                    ? (connector) => (
                        <RowMenu label={`Actions for ${connector.name}`}>
                          <WriteMenuItem onPress={() => edit(connector)} purpose={`change ${connector.name}`} resume="Change">
                            <Pencil />
                            Change
                          </WriteMenuItem>
                          <DropdownMenuSeparator />
                          <WriteMenuItem variant="destructive" onPress={() => askRemoval(connector)} purpose={`remove ${connector.name}`} resume="Remove connector">
                            <Trash2 />
                            Remove connector
                          </WriteMenuItem>
                        </RowMenu>
                      )
                    : undefined
                }
                empty={
                  query !== "" ? (
                    <InlineEmpty
                      icon={Plug}
                      action={
                        <Button variant="link" className="h-auto p-0" onClick={search.clear}>
                          Clear search
                        </Button>
                      }
                    >
                      No connectors match "{search.query.trim()}".
                    </InlineEmpty>
                  ) : (
                    <InlineEmpty
                      icon={Plug}
                      action={
                        canWrite ? (
                          <WriteButton variant="link" className="h-auto p-0" onPress={() => add()} purpose="add a connector" resume="Add connector">
                            Add connector
                          </WriteButton>
                        ) : undefined
                      }
                    >
                      No connector yet. Lend a credential to a project without putting it in its code.
                    </InlineEmpty>
                  )
                }
              />
            </Panel>
          </div>
        )}
      </PageBody>

      {ready !== null && (
        <ConnectorSheet
          connector={opened}
          view={ready}
          known={known}
          serverNow={actions.serverNow}
          canWrite={canWrite}
          inFlight={grantInFlight}
          error={opened === null ? "" : grantError}
          activity={activity}
          onClose={sheet.close}
          onToggle={(row) => void toggle(row)}
          onEdit={edit}
          onRemove={askRemoval}
        />
      )}

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
          if (sheet.id === name) sheet.close()
          written(view, `Connector ${name} removed.`)
        }}
        onLocked={locked}
        focusReturn={focusReturn}
      />
    </>
  )
}
