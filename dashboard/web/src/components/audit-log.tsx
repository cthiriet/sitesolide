import { Fragment, useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InternalLink } from "@/components/navigation"
import { Banner, Status } from "@/components/page"
import { SOURCES, actorLabel, auditWords, detailLines, sourceLabel, sourceWords, type AuditFilters } from "@/lib/audit"
import { ABSENT, ago, dateTime } from "@/lib/format"
import { siteUrl } from "@/lib/pages"
import type { AuditRow, AuditSource, SourceStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The pieces of the Activity page: the sources' states, the filters, and the
 * log itself, a table when its panel has room for the columns and a list
 * otherwise. Everything a row shows is text: an actor, a target or a detail
 * comes from a component, sometimes from a stranger, and is never read as
 * markup.
 */

// --- The sources -----------------------------------------------------------------

/**
 * Every source once, with its state; then, for those that could not be read
 * or need updating, what happened and what to do. One that is not installed
 * says so in the strip and nothing more: it is not a fault.
 */
export function SourceStates({ statuses }: { statuses: readonly SourceStatus[] }) {
  if (statuses.length === 0) return null
  const problems = statuses.filter((status) => status.state === "unavailable" || status.state === "outdated")
  return (
    <div className="grid gap-2">
      <ul aria-label="Sources" className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
        {statuses.map((status) => {
          const words = sourceWords(status)
          return (
            <li key={status.name} className="flex items-center gap-2" title={status.message ?? undefined}>
              <span className="font-medium">{sourceLabel(status.name)}</span>
              <Status tone={words.tone} className="text-xs">
                {words.word}
              </Status>
            </li>
          )
        })}
      </ul>
      {problems.map((status) => (
        <Banner key={status.name} tone={status.state === "unavailable" ? "error" : "attention"}>
          <span className="font-medium">{sourceLabel(status.name)}:</span> {status.message}
        </Banner>
      ))}
    </div>
  )
}

// --- The filters -----------------------------------------------------------------

/** One source or every one, the chosen one on the white surface, like the home page's filters. */
function SourceChips({ value, onValue }: { value: AuditSource | null; onValue: (source: AuditSource | null) => void }) {
  const choices: { key: AuditSource | null; label: string; description: string }[] = [{ key: null, label: "All", description: "Every source" }, ...SOURCES]
  return (
    <div role="group" aria-label="Filter by source" className="grid w-full grid-cols-3 gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5 sm:inline-flex sm:w-auto">
      {choices.map((choice) => {
        const selected = choice.key === value
        return (
          <button
            key={choice.key ?? "all"}
            type="button"
            aria-pressed={selected}
            title={choice.description}
            onClick={() => onValue(choice.key)}
            className={cn(
              "inline-flex h-9 min-w-0 items-center justify-center rounded-md px-1.5 text-[0.8125rem] whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 sm:px-2.5 sm:text-sm",
              selected ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {choice.label}
          </button>
        )
      })}
    </div>
  )
}

function FilterField({ label, children, id, className }: { label: string; id: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

const FIELD = "h-10 bg-card md:h-9 dark:bg-card"

/**
 * The source, then the fields: an actor by any part of it, an action by its
 * beginning, a site or a host, and whole days. `count` says what is shown, on
 * the right.
 */
export function AuditFilterBar({
  filters,
  onFilters,
  onClear,
  narrowed,
  count,
}: {
  filters: AuditFilters
  onFilters: (filters: AuditFilters) => void
  onClear: () => void
  narrowed: boolean
  count: ReactNode
}) {
  const id = useId()
  const set = (key: keyof AuditFilters) => (event: { target: { value: string } }) => onFilters({ ...filters, [key]: event.target.value })
  return (
    <section aria-label="Filters" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SourceChips value={filters.source} onValue={(source) => onFilters({ ...filters, source })} />
        {narrowed && (
          <Button variant="ghost" size="sm" onClick={onClear} className="text-muted-foreground hover:text-foreground max-md:h-9">
            Clear filters
          </Button>
        )}
        <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums sm:ml-auto">
          {count}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 @4xl/body:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,9.5rem)_minmax(0,9.5rem)]">
        <FilterField label="Actor" id={`${id}-actor`}>
          <Input id={`${id}-actor`} value={filters.actor} onChange={set("actor")} placeholder="email, owner, token:…" autoComplete="off" spellCheck={false} className={FIELD} />
        </FilterField>
        <FilterField label="Action" id={`${id}-action`}>
          <Input id={`${id}-action`} value={filters.action} onChange={set("action")} placeholder="portal., deploy.failure" autoComplete="off" spellCheck={false} className={FIELD} />
        </FilterField>
        <FilterField label="Site or host" id={`${id}-target`} className="col-span-2 @4xl/body:col-span-1">
          <Input id={`${id}-target`} value={filters.target} onChange={set("target")} placeholder="a slug, or one of its hosts" autoComplete="off" spellCheck={false} className={FIELD} />
        </FilterField>
        <FilterField label="From" id={`${id}-from`}>
          <Input id={`${id}-from`} type="date" value={filters.from} max={filters.to || undefined} onChange={set("from")} className={FIELD} />
        </FilterField>
        <FilterField label="To" id={`${id}-to`}>
          <Input id={`${id}-to`} type="date" value={filters.to} min={filters.from || undefined} onChange={set("to")} className={FIELD} />
        </FilterField>
      </div>
    </section>
  )
}

// --- A row -----------------------------------------------------------------------

function When({ at, serverNow }: { at: string; serverNow: number }) {
  const ms = Date.parse(at)
  // An unreadable date must not bring the page down: Date and Intl throw on NaN.
  if (!Number.isFinite(ms)) return <span className="text-muted-foreground">{ABSENT}</span>
  return (
    <time dateTime={at} title={dateTime(ms)} className="whitespace-nowrap text-muted-foreground tabular-nums">
      {ago(serverNow - ms)}
    </time>
  )
}

const LINK = "rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"

/**
 * The site, linked when the server still has it; the host or name recorded,
 * when it says more. `compact`, on one line among others: the site alone, the
 * host stays in the details.
 */
function Target({ row, known, compact = false }: { row: AuditRow; known: ReadonlySet<string>; compact?: boolean }) {
  if (row.target === null) return <span className="text-muted-foreground">{ABSENT}</span>
  const site =
    row.site !== null && known.has(row.site) ? (
      <InternalLink href={siteUrl(row.site)} className={LINK}>
        {row.site}
      </InternalLink>
    ) : (
      <span>{row.site ?? row.target}</span>
    )
  if (compact) return <span className="wrap-anywhere">{site}</span>
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="wrap-anywhere">{site}</span>
      {row.site !== null && row.target.toLowerCase() !== row.site && <span className="text-xs text-muted-foreground wrap-anywhere">{row.target}</span>}
    </span>
  )
}

function Summary({ row }: { row: AuditRow }) {
  const words = auditWords(row)
  return (
    <span className="grid min-w-0 gap-0.5">
      {words.tone === "attention" || words.tone === "error" ? (
        <Status tone={words.tone} className="whitespace-normal">
          {words.summary}
        </Status>
      ) : (
        <span className="wrap-anywhere">{words.summary}</span>
      )}
      <span className="text-xs text-muted-foreground wrap-anywhere">
        {row.action}
        {words.note !== null && ` · ${words.note}`}
      </span>
    </span>
  )
}

/** Everything the row holds, as key and value: the fields first, then the component's detail. */
function Details({ row, id }: { row: AuditRow; id: string }) {
  const ms = Date.parse(row.at)
  const lines = [
    { key: "time", value: Number.isFinite(ms) ? `${dateTime(ms)} (${row.at})` : row.at },
    { key: "source", value: sourceLabel(row.source) },
    { key: "actor", value: row.actor },
    { key: "action", value: row.action },
    { key: "target", value: row.target ?? "none" },
    ...detailLines(row.detail),
  ]
  return (
    <dl id={id} className="grid gap-x-6 gap-y-1 text-xs @xl:grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)]">
      {lines.map((line, index) => (
        <Fragment key={`${line.key}-${index}`}>
          <dt className="text-muted-foreground">{line.key}</dt>
          <dd className="min-w-0 wrap-anywhere @max-xl:mb-1.5">{line.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function Toggle({ open, controls, onToggle, labelled = false }: { open: boolean; controls: string; onToggle: () => void; labelled?: boolean }) {
  return (
    <Button
      variant="ghost"
      size={labelled ? "sm" : "icon-sm"}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={labelled ? undefined : open ? "Hide details" : "Show details"}
      title={open ? "Hide details" : "Show details"}
      onClick={onToggle}
      className={cn("text-muted-foreground hover:text-foreground", labelled ? "max-md:h-9" : "max-md:size-10")}
    >
      {labelled && "Details"}
      <ChevronDown className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
    </Button>
  )
}

// --- The log ---------------------------------------------------------------------

/** Newest first: a table from 48 rem of panel, five columns needing more than the Guests table, a list below, each row with its details on demand. */
export function AuditLog({ rows, known, serverNow, caption }: { rows: readonly AuditRow[]; known: ReadonlySet<string>; serverNow: number; caption: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const base = useId()
  const toggle = (id: string) =>
    setOpen((before) => {
      const next = new Set(before)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const detailId = (row: AuditRow, where: string) => `${base}-${where}-${row.id.replace(/[^A-Za-z0-9_-]/g, "_")}`

  return (
    <div className="@container">
      <table className="hidden w-full text-sm @3xl:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="h-9 border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
            <th scope="col" className="px-3 pl-4 font-medium">
              Actor
            </th>
            <th scope="col" className="px-3 font-medium">
              Action
            </th>
            <th scope="col" className="px-3 font-medium">
              Target
            </th>
            <th scope="col" className="px-3 font-medium">
              Source
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              When
            </th>
            <th scope="col" className="w-12 px-3 pr-4">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const expanded = open.has(row.id)
            const id = detailId(row, "table")
            return (
              <Fragment key={row.id}>
                <tr className="align-top">
                  <td className="max-w-[16rem] px-3 py-2.5 pl-4 wrap-anywhere">{actorLabel(row)}</td>
                  <td className="px-3 py-2.5">
                    <Summary row={row} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Target row={row} known={known} />
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{sourceLabel(row.source)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <When at={row.at} serverNow={serverNow} />
                  </td>
                  <td className="px-3 py-1.5 pr-4 text-right">
                    <Toggle open={expanded} controls={id} onToggle={() => toggle(row.id)} />
                  </td>
                </tr>
                {expanded && (
                  <tr className="bg-muted/30">
                    <td colSpan={6} className="px-4 py-3">
                      <Details row={row} id={id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      <ol aria-label={caption} className="divide-y @3xl:hidden">
        {rows.map((row) => {
          const expanded = open.has(row.id)
          const id = detailId(row, "list")
          return (
            <li key={row.id} className="grid gap-y-1.5 px-4 py-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span className="text-sm">
                  <Summary row={row} />
                </span>
                <span className="text-xs">
                  <When at={row.at} serverNow={serverNow} />
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="wrap-anywhere text-foreground">{actorLabel(row)}</span>
                {row.target !== null && <Target row={row} known={known} compact />}
                <span>{sourceLabel(row.source)}</span>
                <span className="ml-auto">
                  <Toggle open={expanded} controls={id} onToggle={() => toggle(row.id)} labelled />
                </span>
              </div>
              {expanded && (
                <div className="rounded-md bg-muted/40 px-3 py-2.5">
                  <Details row={row} id={id} />
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
