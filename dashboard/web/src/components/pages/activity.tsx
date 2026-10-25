import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Download, History } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ActivityLog, EventSheet, RangeDialog, SourceProblems } from "@/components/audit-log"
import { useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { useSheet } from "@/components/detail-sheet"
import { FilterBar, useListState, type Facet } from "@/components/filter-bar"
import { useNavigation } from "@/components/navigation"
import { ErrorState, InlineEmpty, PageBody, PageHeader, Panel, RowsSkeleton, useRetry } from "@/components/page"
import {
  SOURCES,
  UNTIL_PARAM,
  activityDays,
  activityKeep,
  auditQuery,
  dayKey,
  exportName,
  isAuditResponse,
  isDay,
  isNarrowed,
  mergeStatuses,
  readActivity,
  readAudit,
  refreshRows,
  serverKey,
  toCsv,
  toJsonLines,
  windowNote,
  type ActivityFilter,
} from "@/lib/audit"
import { HISTORY_TYPES, SINCE_CHOICES } from "@/lib/history"
import type { ListSpec } from "@/lib/list-state"
import type { AuditRow, SourceStatus } from "@/lib/types"

/**
 * The machine's audit: who deployed, who signed in where, who changed who
 * gets in, what the egress proxy refused or lent, which backups ran or were
 * restored, which secrets were read or changed. Every component keeps its own
 * audit; the service reads them all and merges them, newest first.
 *
 * The session is enough to read it, with no unlock: no row carries a secret
 * value. The page reads `/api/audit` itself, fifty rows at a time, and again
 * with every snapshot to put the newest rows on top. The exports are made
 * here, from the rows shown.
 *
 * Its address is the History contract every History link speaks
 * (lib/history.ts), `actor`, `action`, `target`, `source`, `type`, `since`,
 * plus its own search, `q`, and a custom range's last day, `until`.
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
 * within a budget and says to go on, and the page narrows a type and its
 * search itself. It goes on by itself this many times before handing the
 * choice back.
 */
const AUTO_PAGES = 5

function failure(status: number, body: { message?: string } | null): string {
  if (status === 0 || status === 502) return "Can't reach the dashboard."
  if (status === 400 && typeof body?.message === "string") return `Refused: ${body.message}`
  return `Refused (${status}).`
}

/** Pages from `cursor` on, until one holds a row the page keeps, the log ends, or `pages` went by. */
async function fetchPages(
  filter: ActivityFilter,
  cursor: string | null,
  keep: (row: AuditRow) => boolean,
  pages = AUTO_PAGES,
): Promise<Fetched> {
  const rows: AuditRow[] = []
  let scanned = 0
  let statuses: SourceStatus[] = []
  let next = cursor
  for (let page = 0; page < pages; page++) {
    const { status, body } = await readAudit(auditQuery(filter, Date.now(), next))
    if (status === 401) return { kind: "session" }
    if (status !== 200 || !isAuditResponse(body)) return { kind: "error", message: failure(status, body) }
    rows.push(...body.rows)
    scanned += body.scanned
    statuses = mergeStatuses(statuses, body.sources)
    next = body.cursor
    if (rows.some(keep) || next === null) break
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

/** `2026-10-21` as the Date facet says it, `Oct 21`. */
function shortDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

/** A custom range in words: "Since Oct 21", "Oct 21", "Oct 21 to Oct 23". */
function rangeWords(since: string, until: string | undefined): string {
  if (until === undefined) return `Since ${shortDate(since)}`
  if (until === since) return shortDate(since)
  return `${shortDate(since)} to ${shortDate(until)}`
}

const SOURCE_KEYS = SOURCES.map((source) => source.key)
const TYPE_KEYS = HISTORY_TYPES.map((type) => type.key)
const RANGE_KEYS: readonly string[] = SINCE_CHOICES.map((choice) => choice.key)

/** The address's actor, action and target, which only a link brings: each a facet of its one value, "Actor: owner" with its x. */
const LINKED = [
  { name: "actor", label: "Actor", all: "Anyone" },
  { name: "action", label: "Action", all: "Any action" },
  { name: "target", label: "Target", all: "Anything" },
] as const

export function ActivityPage() {
  const { generation, snapshot, now, offset, sessionExpired } = useData()
  const announce = useAnnounce()
  const { params, path, navigate } = useNavigation()
  const sheet = useSheet("event")
  const serverNow = now + offset
  const search = params.toString()

  const filter = useMemo(() => readActivity(new URLSearchParams(search)), [search])
  const key = serverKey(filter)
  const keep = useMemo(() => activityKeep(filter), [filter])
  const raw = (name: string) => new URLSearchParams(search).get(name)?.slice(0, 200) ?? ""
  const customDay = filter.since !== undefined && isDay(filter.since) ? filter.since : null
  const linked = LINKED.map((entry) => ({ ...entry, value: raw(entry.name) })).filter((entry) => entry.value !== "")
  const specKey = JSON.stringify([customDay, linked.map((entry) => [entry.name, entry.value])])
  // The list's spec follows the address: a custom day is one more value of
  // the Date facet, and each linked field a facet of its own value. Rebuilt
  // only when those change, so that it stays one object between renders.
  const spec = useMemo<ListSpec>(
    () => ({
      facets: {
        source: SOURCE_KEYS,
        type: TYPE_KEYS,
        since: customDay === null ? RANGE_KEYS : [...RANGE_KEYS, customDay],
        ...Object.fromEntries(linked.map((entry) => [entry.name, [entry.value]])),
      },
    }),
    [specKey],
  )
  const list = useListState(spec)

  const [log, setLog] = useState<LogState>({ state: "loading" })
  const [seen, setSeen] = useState<SourceStatus[]>([])
  const [more, setMore] = useState(false)
  const [range, setRange] = useState(false)
  // The read that counts: an answer to filters changed since is dropped.
  const sequence = useRef(0)
  const seenGeneration = useRef(generation)
  const current = useRef({ filter, keep })
  current.current = { filter, keep }
  // The search, or the type, for which the page already went on by itself.
  const autoFor = useRef("")

  const load = useCallback(async () => {
    const mine = ++sequence.current
    const { filter: wanted, keep: kept } = current.current
    autoFor.current = `${serverKey(wanted)}\u0000${wanted.query ?? ""}`
    const fetched = await fetchPages(wanted, null, kept)
    if (mine !== sequence.current) return
    if (fetched.kind === "session") return sessionExpired()
    if (fetched.kind === "error") return setLog({ state: "error", message: fetched.message })
    setSeen((before) => mergeStatuses(before, fetched.statuses))
    setLog({ state: "ready", rows: fetched.rows, cursor: fetched.cursor, scanned: fetched.scanned, statuses: fetched.statuses })
  }, [sessionExpired])

  // What the server is asked changed: the log is read again from its newest page. The search alone reads nothing.
  useEffect(() => {
    setLog({ state: "loading" })
    void load()
  }, [key, load])

  // With every snapshot, the newest page again, put on top of what is shown.
  useEffect(() => {
    if (seenGeneration.current === generation) return
    seenGeneration.current = generation
    if (log.state !== "ready" || more) return
    const mine = sequence.current
    const { filter: wanted, keep: kept } = current.current
    void (async () => {
      const fetched = await fetchPages(wanted, null, kept, 1)
      if (mine !== sequence.current || fetched.kind !== "ok") return
      setSeen((before) => mergeStatuses(before, fetched.statuses))
      setLog((before) => {
        if (before.state !== "ready") return before
        const newest = { rows: fetched.rows, cursor: fetched.cursor, sources: fetched.statuses, scanned: fetched.scanned }
        const { rows, restart } = refreshRows(before.rows, newest)
        const statuses = mergeStatuses(before.statuses, fetched.statuses)
        return restart
          ? { state: "ready", rows, cursor: fetched.cursor, scanned: fetched.scanned, statuses }
          : { ...before, rows, statuses }
      })
    })()
  }, [generation, log.state, more])

  const loadOlder = useCallback(
    async (quiet = false) => {
      if (log.state !== "ready" || log.cursor === null) return
      const mine = sequence.current
      const { filter: wanted, keep: kept } = current.current
      setMore(true)
      try {
        const fetched = await fetchPages(wanted, log.cursor, kept)
        if (mine !== sequence.current) return
        if (fetched.kind === "session") return sessionExpired()
        if (fetched.kind === "error") return announce(fetched.message)
        setSeen((before) => mergeStatuses(before, fetched.statuses))
        setLog((before) => {
          if (before.state !== "ready") return before
          const known = new Set(before.rows.map((row) => row.id))
          const older = fetched.rows.filter((row) => !known.has(row.id))
          return {
            state: "ready",
            rows: [...before.rows, ...older],
            cursor: fetched.cursor,
            scanned: before.scanned + fetched.scanned,
            statuses: mergeStatuses(before.statuses, fetched.statuses),
          }
        })
        const found = fetched.rows.filter(kept).length
        if (!quiet) announce(found === 0 ? "No older events found yet." : `${found} older ${found === 1 ? "event" : "events"} loaded.`)
      } finally {
        setMore(false)
      }
    },
    [log, sessionExpired, announce],
  )

  const rows = log.state === "ready" ? log.rows : []
  const visible = useMemo(() => rows.filter(keep), [rows, keep])

  // A search that finds nothing in the rows read goes on by itself, once, the way the first read does.
  useEffect(() => {
    if (log.state !== "ready" || log.cursor === null || more || visible.length > 0) return
    const wanted = `${key}\u0000${filter.query ?? ""}`
    if (autoFor.current === wanted) return
    autoFor.current = wanted
    void loadOlder(true)
  }, [log, more, visible.length, key, filter.query, loadOlder])

  // A range's end without its start, left by clearing the Date facet, leaves the address too.
  useEffect(() => {
    const next = new URLSearchParams(search)
    if (!next.has(UNTIL_PARAM) || filter.until !== undefined) return
    next.delete(UNTIL_PARAM)
    const text = next.toString()
    navigate(`${path}${text === "" ? "" : `?${text}`}`, { replace: true })
  }, [search, filter.until, path, navigate])

  const { retrying, retry } = useRetry(load)

  function exportRows(kind: "csv" | "jsonl") {
    if (visible.length === 0) return
    if (kind === "csv") save(toCsv(visible), "text/csv;charset=utf-8", exportName("csv", new Date()))
    else save(toJsonLines(visible), "application/x-ndjson", exportName("jsonl", new Date()))
    announce(`${visible.length} ${visible.length === 1 ? "event" : "events"} exported as ${kind === "csv" ? "CSV" : "JSON lines"}.`)
  }

  function applyRange(since: string, until: string | null) {
    const next = new URLSearchParams(search)
    next.set("since", since)
    if (until === null) next.delete(UNTIL_PARAM)
    else next.set(UNTIL_PARAM, until)
    navigate(`${path}?${next}`, { replace: true })
    setRange(false)
  }

  function clearAll() {
    navigate(path, { replace: true })
  }

  const ready = log.state === "ready" ? log : null
  const narrowed = isNarrowed(filter)
  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const days = activityDays(visible, serverNow)
  const note = ready === null || ready.cursor !== null ? null : windowNote(ready.statuses)
  const openRow = sheet.id === null ? null : (rows.find((row) => row.id === sheet.id) ?? null)
  const today = dayKey(serverNow)

  const facets: Facet[] = [
    { name: "source", label: "Source", options: SOURCES.map((source) => ({ value: source.key, label: source.label })) },
    { name: "type", label: "Type", options: HISTORY_TYPES.map((type) => ({ value: type.key, label: type.label })) },
    {
      name: "since",
      label: "Date",
      all: "Any time",
      options: [
        ...SINCE_CHOICES.map((choice) => ({ value: choice.key, label: choice.label })),
        ...(customDay === null ? [] : [{ value: customDay, label: rangeWords(customDay, filter.until) }]),
      ],
      more: { label: "Custom range…", onSelect: () => setRange(true) },
    },
    ...linked.map((entry): Facet => ({
      name: entry.name,
      label: entry.label,
      all: entry.all,
      options: [{ value: entry.value, label: entry.value }],
    })),
  ]

  // Nothing to export before something has been read.
  const actions =
    ready === null ? undefined : (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" disabled={visible.length === 0} className="max-md:h-10" />}>
          <Download />
          Export
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>The {visible.length === 1 ? "event" : `${visible.length} events`} shown</DropdownMenuLabel>
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
      <PageHeader
        title="Activity"
        intro={
          <>
            <p>
              Who did what on this server, from every component's own audit: deployments and tokens, sign-ins and who gets in, egress
              refusals and connectors, backups and restores, secrets and access changes. Values never appear here.
            </p>
            <p className="text-muted-foreground">
              Newest first, fifty at a time. The same event repeated in a row folds into one line with its count; a row opens every field it
              holds.
            </p>
          </>
        }
        actions={actions}
      />
      <PageBody>
        <SourceProblems statuses={seen} />

        <FilterBar
          list={list}
          facets={facets}
          shown={visible.length}
          total={rows.length}
          count={null}
          noun={{ one: "event", many: "events" }}
          search={{ label: "Search activity" }}
        />

        <Panel full>
          {log.state === "loading" && (
            <div aria-busy="true" aria-label="Loading activity">
              <RowsSkeleton lines={8} />
            </div>
          )}

          {log.state === "error" && (
            <ErrorState title={log.message} onRetry={retry} inProgress={retrying}>
              {log.message === "Can't reach the dashboard."
                ? "The server didn't answer. Check your connection, then try again."
                : undefined}
            </ErrorState>
          )}

          {ready !== null && visible.length === 0 && (
            <InlineEmpty
              icon={History}
              action={
                ready.cursor !== null ? (
                  <Button variant="link" className="h-auto p-0" disabled={more} onClick={() => void loadOlder()}>
                    {more ? "Loading…" : "Load older"}
                  </Button>
                ) : narrowed ? (
                  <Button variant="link" className="h-auto p-0" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {ready.cursor !== null
                ? more
                  ? `Nothing matches in the ${rows.length} latest events yet. Reading older ones…`
                  : `Nothing matches in the ${rows.length} latest events.`
                : narrowed
                  ? "No activity matches these filters."
                  : "No activity yet: deployments, sign-ins, access changes and backups show up here."}
            </InlineEmpty>
          )}

          {ready !== null && visible.length > 0 && (
            <ActivityLog days={days} known={known} serverNow={serverNow} selected={sheet.id} onOpen={(row) => sheet.open(row.id)} />
          )}

          {ready !== null && visible.length > 0 && ready.cursor !== null && (
            <div className="flex items-center justify-between gap-3 border-t px-2 py-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadOlder()}
                disabled={more}
                className="text-muted-foreground hover:text-foreground max-md:h-9"
              >
                {more ? "Loading…" : "Load older"}
              </Button>
              <span className="px-2 text-xs text-muted-foreground tabular-nums">
                {visible.length === rows.length ? `${rows.length} events read` : `${visible.length} of ${rows.length} read`}
              </span>
            </div>
          )}
        </Panel>

        {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
      </PageBody>

      <EventSheet row={openRow} known={known} onClose={sheet.close} />
      <RangeDialog
        open={range}
        onOpenChange={setRange}
        since={customDay ?? ""}
        until={filter.until ?? ""}
        today={today}
        onApply={applyRange}
      />
    </>
  )
}
