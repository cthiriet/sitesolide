import { useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CellText, DataTable, RowButton, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetSection } from "@/components/detail-sheet"
import { TEXT_LINK } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import { Banner, Count, FormError, INPUT_DIALOG, SeverityIcon, When } from "@/components/page"
import {
  actorLabel,
  auditWords,
  clockTime,
  dayKey,
  detailLines,
  isDay,
  sourceLabel,
  type ActivityDay,
  type ActivityItem,
  type AuditWords,
} from "@/lib/audit"
import { dateTime } from "@/lib/format"
import { historyUrl } from "@/lib/history"
import { siteUrl } from "@/lib/pages"
import { TONE_TEXT } from "@/lib/tones"
import type { AuditRow, SourceStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/**
 * The pieces of the Activity page: the sources that could not be read, the
 * log cut into days, the sheet of one event, and the custom range.
 * Everything a row shows is text: an actor, a target or a detail comes from
 * a component, sometimes from a stranger, and is never read as markup.
 */

// --- The sources -----------------------------------------------------------------

/**
 * A source that could not be read, or needs updating, as a banner saying
 * what happened and what to do. A source read is not news, and says
 * nothing; one not installed is no fault either.
 */
export function SourceProblems({ statuses }: { statuses: readonly SourceStatus[] }) {
  const problems = statuses.filter((status) => status.state === "unavailable" || status.state === "outdated")
  if (problems.length === 0) return null
  return (
    <div className="grid gap-2">
      {problems.map((status) => (
        <Banner key={status.name} tone={status.state === "unavailable" ? "error" : "attention"}>
          <span className="font-medium">{sourceLabel(status.name)}:</span> {status.message}
        </Banner>
      ))}
    </div>
  )
}

// --- The log ---------------------------------------------------------------------

/** One line of a day's table: an event, a run's head, or one event of a run opened. */
type Line = {
  key: string
  row: AuditRow
  words: AuditWords
  /** A run's head: how many events it folds, and whether they show. */
  run: { count: number; open: boolean } | null
  /** One event of a run opened, under its head. */
  child: boolean
}

const failed = (words: AuditWords) => words.tone === "error" || words.tone === "attention"

function severityOf(words: AuditWords): Severity | null {
  if (words.tone === "error") return "error"
  if (words.tone === "attention") return "warning"
  return null
}

/** The site, linked while the server still has it; the host or name recorded, as it is, otherwise. */
function Target({ row, known }: { row: AuditRow; known: ReadonlySet<string> }) {
  if (row.target === null) return null
  if (row.site !== null && known.has(row.site)) {
    return (
      <InternalLink href={siteUrl(row.site)} title={row.target} className={cn(TEXT_LINK, "min-w-0 truncate")}>
        {row.site}
      </InternalLink>
    )
  }
  const text = row.site ?? row.target
  return <CellText title={row.target}>{text}</CellText>
}

/**
 * When it happened: an age today, the time of day under an older day's
 * heading, which already says the day. The whole date in the tooltip.
 */
function Time({ row, today, serverNow }: { row: AuditRow; today: boolean; serverNow: number }) {
  const ms = Date.parse(row.at)
  if (today) return <When at={ms} serverNow={serverNow} />
  if (!Number.isFinite(ms)) return <span className="text-muted-foreground">-</span>
  return (
    <time dateTime={new Date(ms).toISOString()} title={dateTime(ms)} className="whitespace-nowrap text-muted-foreground tabular-nums">
      {clockTime(ms)}
    </time>
  )
}

/**
 * The log, newest first: a table per day under its sticky heading, 40 px
 * rows, one line each when the panel has room and two below it. A row is
 * its actor, the sentence in its tone when it went wrong, the site linked,
 * the source and the time; a click opens every field in the sheet. The same
 * event repeated within a day folds into one row with its count, which
 * opens the run.
 */
export function ActivityLog({
  days,
  known,
  serverNow,
  selected,
  onOpen,
}: {
  days: readonly ActivityDay[]
  known: ReadonlySet<string>
  serverNow: number
  selected: string | null
  onOpen: (row: AuditRow) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const today = dayKey(serverNow)

  function toggle(item: ActivityItem) {
    setOpen((before) => {
      const next = new Set(before)
      if (next.has(item.key)) next.delete(item.key)
      else next.add(item.key)
      return next
    })
  }

  const linesOf = (items: readonly ActivityItem[]): Line[] =>
    items.flatMap((item): Line[] => {
      const head = item.rows[0]!
      if (item.rows.length === 1) return [{ key: item.key, row: head, words: item.words, run: null, child: false }]
      const opened = open.has(item.key)
      const runLine: Line = { key: item.key, row: head, words: item.words, run: { count: item.rows.length, open: opened }, child: false }
      if (!opened) return [runLine]
      return [runLine, ...item.rows.map((row): Line => ({ key: row.id, row, words: auditWords(row), run: null, child: true }))]
    })

  const byKey = new Map(days.flatMap((day) => day.items.map((item) => [item.key, item] as const)))

  function press(line: Line) {
    const item = line.run === null ? undefined : byKey.get(line.key)
    if (item !== undefined) toggle(item)
    else onOpen(line.row)
  }

  return (
    <>
      {days.map((day) => {
        const isToday = day.day === today
        const columns: Column<Line>[] = [
          {
            key: "actor",
            head: "Actor",
            width: "minmax(9rem,1fr)",
            slot: "meta",
            cell: (line) => (
              <CellText title={line.row.actor} className={cn(line.child && "text-muted-foreground")}>
                {actorLabel(line.row)}
              </CellText>
            ),
          },
          {
            key: "action",
            head: "Action",
            width: "minmax(14rem,2fr)",
            slot: "primary",
            cell: (line) => <Sentence line={line} onPress={() => press(line)} />,
          },
          {
            key: "target",
            head: "Target",
            width: "minmax(6rem,0.8fr)",
            slot: "meta",
            // On two lines, a row with no target leaves no empty place between two dots; in the columns its track stays.
            className: "@max-3xl/table:empty:hidden",
            cell: (line) => <Target row={line.row} known={known} />,
          },
          {
            key: "source",
            head: "Source",
            width: "6rem",
            slot: "meta",
            cell: (line) => <span className="truncate text-muted-foreground">{sourceLabel(line.row.source)}</span>,
          },
          {
            key: "when",
            head: "When",
            width: "5.5rem",
            align: "end",
            slot: "state",
            cell: (line) => <Time row={line.row} today={isToday} serverNow={serverNow} />,
          },
        ]
        return (
          <DataTable
            key={day.day}
            label={`Activity, ${day.label}`}
            heading={day.label}
            dense
            narrowBelow="48rem"
            rows={linesOf(day.items)}
            rowKey={(line) => line.key}
            columns={columns}
            severity={(line) => severityOf(line.words)}
            onRowClick={press}
            selected={selected}
          />
        )
      })}
    </>
  )
}

/**
 * The row's sentence, the button that opens its sheet, or a run's, which
 * opens the run: the sentence, then the count and a chevron. In its tone
 * when it went wrong, followed then by its note, muted, which says why
 * ("Refused: no secrets permission"): a failure is the one row that says
 * more than its sentence. An event of an opened run says what sets it
 * apart, its note, or the sentence again, muted, set in under its head.
 */
function Sentence({ line, onPress }: { line: Line; onPress: () => void }) {
  const { words } = line
  const wrong = failed(words)
  if (line.child) {
    return (
      <RowButton onClick={onPress} className="pl-5 font-normal text-muted-foreground">
        {words.note ?? words.summary}
      </RowButton>
    )
  }
  if (line.run !== null) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onPress}
          aria-expanded={line.run.open}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            wrong && cn("font-medium", TONE_TEXT[words.tone]),
          )}
        >
          <span className="min-w-0 truncate">{words.summary}</span>
          {wrong && words.note !== null && <Why note={words.note} />}
          <Count className="h-[1.125rem] px-1 text-[0.6875rem]">
            {line.run.count}
            <span className="sr-only"> times</span>
          </Count>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              line.run.open && "rotate-180",
            )}
          />
        </button>
      </span>
    )
  }
  return (
    <RowButton
      onClick={onPress}
      className={cn("flex items-baseline gap-2 font-normal text-foreground", wrong && cn("font-medium", TONE_TEXT[words.tone]))}
    >
      <span className="max-w-full shrink-0 truncate">{words.summary}</span>
      {wrong && words.note !== null && <Why note={words.note} />}
    </RowButton>
  )
}

/**
 * Why a row went wrong, after its sentence: muted, and the first to give
 * way when the line is short. On two lines it leaves the room to the
 * sentence, and waits in the sheet, rather than end cut to a letter.
 */
function Why({ note }: { note: string }) {
  return <span className="min-w-0 truncate text-[0.8125rem] font-normal text-muted-foreground @max-3xl/table:hidden">{note}</span>
}

// --- One event -------------------------------------------------------------------

/**
 * Every field of one event, the sheet `?event=` opens: the sentence as the
 * title, in its tone when it went wrong, the note under it; then when,
 * who, what, on what, from which source, and the component's own detail,
 * key by key, as text. Two links narrow the log to the same actor or the
 * same site.
 */
export function EventSheet({ row, known, onClose }: { row: AuditRow | null; known: ReadonlySet<string>; onClose: () => void }) {
  const words = row === null ? null : auditWords(row)
  const ms = row === null ? Number.NaN : Date.parse(row.at)
  const label = row === null ? "" : actorLabel(row)
  const target = row === null ? null : (row.site ?? row.target)
  const pivot = cn(buttonVariants({ variant: "outline", size: "sm" }), "max-w-full max-md:h-9")
  return (
    <DetailSheet
      open={row !== null}
      onClose={onClose}
      title={words?.summary ?? ""}
      state={words === null || severityOf(words) === null ? undefined : <SeverityIcon severity={severityOf(words)!} label />}
      description={words?.note ?? undefined}
      actions={
        row === null ? undefined : (
          <>
            <InternalLink href={historyUrl({ actor: row.actor })} title={`Everything by ${label}`} className={pivot}>
              Same actor
            </InternalLink>
            {target !== null && (
              <InternalLink href={historyUrl({ target })} title={`Everything on ${target}`} className={pivot}>
                {row.site !== null ? "Same site" : "Same target"}
              </InternalLink>
            )}
          </>
        )
      }
    >
      {row !== null && words !== null && (
        <>
          <SheetFacts
            facts={[
              { label: "When", value: Number.isFinite(ms) ? dateTime(ms) : row.at },
              {
                label: "Actor",
                value: (
                  <span className="grid gap-0.5">
                    <span>{label}</span>
                    {label !== row.actor && <code className="font-mono text-xs text-muted-foreground">{row.actor}</code>}
                  </span>
                ),
              },
              { label: "Action", value: <code className="font-mono text-xs">{row.action}</code> },
              {
                label: "Target",
                value:
                  row.target === null ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <span className="grid gap-0.5">
                      {row.site !== null && known.has(row.site) ? (
                        <InternalLink href={siteUrl(row.site)} className={cn(TEXT_LINK, "w-fit")}>
                          {row.site}
                        </InternalLink>
                      ) : (
                        <span>{row.site ?? row.target}</span>
                      )}
                      {row.site !== row.target && <code className="font-mono text-xs text-muted-foreground">{row.target}</code>}
                    </span>
                  ),
              },
              { label: "Source", value: sourceLabel(row.source) },
            ]}
          />
          <RawDetail row={row} />
        </>
      )}
    </DetailSheet>
  )
}

/** The component's detail, key and value in mono, as the component wrote it: the time as recorded, then each field. */
function RawDetail({ row }: { row: AuditRow }) {
  const lines = [{ key: "at", value: row.at }, ...detailLines(row.detail)]
  return (
    <SheetSection title="Recorded">
      <dl className="grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 font-mono text-xs">
        {lines.map((line, index) => (
          <div key={`${line.key}-${index}`} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{line.key}</dt>
            <dd className="min-w-0 wrap-anywhere">{line.value}</dd>
          </div>
        ))}
      </dl>
    </SheetSection>
  )
}

// --- The custom range ------------------------------------------------------------

/**
 * The Date facet's *Custom range...*: whole days where the person is, the
 * first one asked, the last one optional, both kept in the address as
 * `since` and `until`.
 */
export function RangeDialog({
  open,
  onOpenChange,
  since,
  until,
  today,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  since: string
  until: string
  today: string
  onApply: (since: string, until: string | null) => void
}) {
  const id = useId()
  const [from, setFrom] = useState(since)
  const [to, setTo] = useState(until)
  const [error, setError] = useState("")

  function apply() {
    if (!isDay(from)) return setError("Choose the first day.")
    if (to !== "" && !isDay(to)) return setError("The last day doesn't read as a date.")
    if (to !== "" && to < from) return setError("The last day comes before the first.")
    setError("")
    onApply(from, to === "" ? null : to)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setFrom(since)
          setTo(until)
          setError("")
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className={cn("sm:max-w-sm", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle>Custom range</DialogTitle>
          <DialogDescription>Whole days, where you are. Leave the last day empty to read up to today.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            apply()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field id={`${id}-from`} label="From">
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                max={to || today}
                onChange={(event) => setFrom(event.target.value)}
                className="h-10 md:h-9"
              />
            </Field>
            <Field id={`${id}-to`} label="To">
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                min={from || undefined}
                max={today}
                onChange={(event) => setTo(event.target.value)}
                className="h-10 md:h-9"
              />
            </Field>
          </div>
          <FormError>{error}</FormError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="max-md:h-10">
              Cancel
            </Button>
            <Button type="submit" className="max-md:h-10">
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}
