import { useCallback, useEffect, useRef, useState } from "react"
import { Download, History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AuditFilterBar, AuditLog, SourceStates } from "@/components/audit-log"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { useNavigation } from "@/components/navigation"
import { EmptyState, ErrorState, PageBody, PageHeader, Panel, RowsSkeleton } from "@/components/page"
import {
  NO_FILTERS,
  filtersFrom,
  auditQuery,
  countWords,
  exportName,
  hasFilters,
  isAuditResponse,
  mergeStatuses,
  readAudit,
  refreshRows,
  toCsv,
  toJsonLines,
  windowNote,
  type AuditFilters,
} from "@/lib/audit"
import type { AuditRow, SourceStatus } from "@/lib/types"

/**
 * The machine's audit: who deployed, who signed in where, who changed who
 * gets in, what the egress proxy refused or lent, which backups ran or were
 * restored, which secrets were read or changed. Every component keeps its own
 * audit; the service reads them all and merges them, newest first.
 *
 * The session is enough to read it, with no unlock: no row carries a secret
 * value. The page reads `/api/audit` itself, page by page, and again with
 * every snapshot to put the newest rows on top. The exports are made here,
 * from the rows already read.
 */

type LogState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: AuditRow[]; cursor: string | null; scanned: number; statuses: SourceStatus[] }

type Fetched =
  | { kind: "ok"; rows: AuditRow[]; cursor: string | null; scanned: number; statuses: SourceStatus[] }
  | { kind: "session" }
  | { kind: "error"; message: string }

/**
 * Filters that match rarely give empty pages: the server reads each source
 * within a budget and says to go on. The page goes on by itself this many
 * times before handing the choice back.
 */
const AUTO_PAGES = 5

/** Typing pauses this long before the log is read again. */
const TYPING_MS = 350

function failure(status: number, body: { message?: string } | null): string {
  if (status === 0 || status === 502) return "Can't reach the dashboard."
  if (status === 400 && typeof body?.message === "string") return `Refused: ${body.message}`
  return `Refused (${status}).`
}

/** Pages from `cursor` on, until one holds rows, the log ends, or AUTO_PAGES went by empty. */
async function fetchPages(filters: AuditFilters, cursor: string | null, pages = AUTO_PAGES): Promise<Fetched> {
  const rows: AuditRow[] = []
  let scanned = 0
  let statuses: SourceStatus[] = []
  let next = cursor
  for (let page = 0; page < pages; page++) {
    const { status, body } = await readAudit(auditQuery(filters, next))
    if (status === 401) return { kind: "session" }
    if (status !== 200 || !isAuditResponse(body)) return { kind: "error", message: failure(status, body) }
    rows.push(...body.rows)
    scanned += body.scanned
    statuses = mergeStatuses(statuses, body.sources)
    next = body.cursor
    if (rows.length > 0 || next === null) break
  }
  return { kind: "ok", rows, cursor: next, scanned, statuses }
}

/** A file the browser saves, made from text already in the page. */
function save(content: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function ActivityPage() {
  const { generation, snapshot, now, offset, sessionExpired } = useData()
  const announce = useAnnounce()
  const serverNow = now + offset
  const { params } = useNavigation()
  // A link from elsewhere, a site's Access section, opens the log narrowed.
  const [filters, setFilters] = useState<AuditFilters>(() => filtersFrom(params))
  const [applied, setApplied] = useState<AuditFilters>(() => filtersFrom(params))
  const [log, setLog] = useState<LogState>({ state: "loading" })
  // The strip at the top: every source as last read, kept while other filters
  // load, and for the sources a filter leaves out.
  const [seen, setSeen] = useState<SourceStatus[]>([])
  const [more, setMore] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // The read that counts: an answer to filters changed since is dropped.
  const sequence = useRef(0)
  const typing = useRef<number | null>(null)
  const seenGeneration = useRef(generation)

  const load = useCallback(
    async (wanted: AuditFilters) => {
      const mine = ++sequence.current
      const fetched = await fetchPages(wanted, null)
      if (mine !== sequence.current) return
      if (fetched.kind === "session") return sessionExpired()
      if (fetched.kind === "error") return setLog({ state: "error", message: fetched.message })
      setSeen((before) => mergeStatuses(before, fetched.statuses))
      setLog({ state: "ready", rows: fetched.rows, cursor: fetched.cursor, scanned: fetched.scanned, statuses: fetched.statuses })
    },
    [sessionExpired],
  )

  useEffect(() => {
    setLog({ state: "loading" })
    void load(applied)
  }, [applied, load])

  // With every snapshot, the newest page again, put on top of what is shown.
  useEffect(() => {
    if (seenGeneration.current === generation) return
    seenGeneration.current = generation
    if (log.state !== "ready" || more) return
    const mine = sequence.current
    void (async () => {
      const fetched = await fetchPages(applied, null, 1)
      if (mine !== sequence.current || fetched.kind !== "ok") return
      setSeen((before) => mergeStatuses(before, fetched.statuses))
      setLog((before) => {
        if (before.state !== "ready") return before
        const newest = { rows: fetched.rows, cursor: fetched.cursor, sources: fetched.statuses, scanned: fetched.scanned }
        const { rows, restart } = refreshRows(before.rows, newest)
        const statuses = mergeStatuses(before.statuses, fetched.statuses)
        return restart ? { state: "ready", rows, cursor: fetched.cursor, scanned: fetched.scanned, statuses } : { ...before, rows, statuses }
      })
    })()
  }, [generation, log.state, more, applied])

  useEffect(() => () => {
    if (typing.current !== null) window.clearTimeout(typing.current)
  }, [])

  /** The source and the days apply at once; what is typed, once typing pauses. */
  function changeFilters(next: AuditFilters) {
    const typed = next.actor !== filters.actor || next.action !== filters.action || next.target !== filters.target
    setFilters(next)
    if (typing.current !== null) window.clearTimeout(typing.current)
    if (typed) typing.current = window.setTimeout(() => setApplied(next), TYPING_MS)
    else setApplied(next)
  }

  async function loadOlder() {
    if (log.state !== "ready" || log.cursor === null) return
    const mine = sequence.current
    setMore(true)
    try {
      const fetched = await fetchPages(applied, log.cursor)
      if (mine !== sequence.current) return
      if (fetched.kind === "session") return sessionExpired()
      if (fetched.kind === "error") return announce(fetched.message)
      setSeen((before) => mergeStatuses(before, fetched.statuses))
      setLog((before) => {
        if (before.state !== "ready") return before
        const known = new Set(before.rows.map((row) => row.id))
        const older = fetched.rows.filter((row) => !known.has(row.id))
        return { state: "ready", rows: [...before.rows, ...older], cursor: fetched.cursor, scanned: before.scanned + fetched.scanned, statuses: mergeStatuses(before.statuses, fetched.statuses) }
      })
      announce(fetched.rows.length === 0 ? "No older events found yet." : `${fetched.rows.length} older ${fetched.rows.length === 1 ? "event" : "events"} loaded.`)
    } finally {
      setMore(false)
    }
  }

  async function retry() {
    setRetrying(true)
    try {
      await load(applied)
    } finally {
      setRetrying(false)
    }
  }

  function exportRows(kind: "csv" | "jsonl") {
    if (log.state !== "ready" || log.rows.length === 0) return
    const rows = log.rows
    if (kind === "csv") save(toCsv(rows), "text/csv;charset=utf-8", exportName("csv", new Date()))
    else save(toJsonLines(rows), "application/x-ndjson", exportName("jsonl", new Date()))
    announce(`${rows.length} ${rows.length === 1 ? "event" : "events"} exported as ${kind === "csv" ? "CSV" : "JSON lines"}.`)
  }

  const ready = log.state === "ready" ? log : null
  const narrowed = hasFilters(applied)
  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const note = ready === null || ready.cursor !== null ? null : windowNote(ready.statuses)
  const caption = `Events from every component, newest first${narrowed ? ", filtered" : ""}`

  // Nothing to export before something has been read.
  const actions =
    ready === null ? undefined : (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" disabled={ready.rows.length === 0} className="max-md:h-10" />}>
          <Download />
          Export
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>The {ready.rows.length === 1 ? "event" : `${ready.rows.length} events`} shown</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => exportRows("csv")} className="h-9">
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportRows("jsonl")} className="h-9">
              JSON lines
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )

  return (
    <>
      <PageHeader title="Activity" actions={actions} />
      <PageBody>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Who did what on this server, from every component's own audit: deployments and tokens, sign-ins and who gets in,
          egress refusals and connectors, backups and restores, secrets and access changes. Values never appear here.
        </p>

        <SourceStates statuses={seen} />

        <AuditFilterBar
          filters={filters}
          onFilters={changeFilters}
          onClear={() => changeFilters(NO_FILTERS)}
          narrowed={hasFilters(filters)}
          count={ready === null ? "" : countWords(ready.rows.length, narrowed)}
        />

        <Panel full>
          {log.state === "loading" && (
            <div aria-busy="true" aria-label="Loading activity">
              <RowsSkeleton lines={6} />
            </div>
          )}

          {log.state === "error" && (
            <ErrorState title={log.message} onRetry={() => void retry()} inProgress={retrying}>
              {log.message === "Can't reach the dashboard." ? "The server didn't answer. Check your connection, then try again." : undefined}
            </ErrorState>
          )}

          {ready !== null && ready.rows.length === 0 && (
            <EmptyState
              icon={History}
              title={ready.cursor !== null ? "Nothing matches in the most recent entries" : narrowed ? "No activity matches these filters" : "No activity yet"}
              action={
                narrowed && ready.cursor === null ? (
                  <Button variant="outline" onClick={() => changeFilters(NO_FILTERS)} className="max-md:h-10">
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {ready.cursor !== null
                ? `${ready.scanned} entries read so far. Older ones may still match.`
                : narrowed
                  ? "Try another actor, action or site, or a wider range of days."
                  : "Deployments, sign-ins, access changes, egress refusals, backups and secret operations show up here."}
            </EmptyState>
          )}

          {ready !== null && ready.rows.length > 0 && <AuditLog rows={ready.rows} known={known} serverNow={serverNow} caption={caption} />}

          {ready !== null && ready.cursor !== null && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-4 py-2.5">
              <span className="text-xs text-muted-foreground tabular-nums">{ready.scanned} entries read</span>
              <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={more} className="max-md:h-10">
                {more ? "Loading…" : "Load older"}
              </Button>
            </div>
          )}
        </Panel>

        {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
      </PageBody>
    </>
  )
}
