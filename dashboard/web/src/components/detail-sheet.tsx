import { useEffect, useRef, useState, type ReactNode } from "react"
import { History } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useData } from "@/components/data"
import { InternalLink, useNavigation } from "@/components/navigation"
import { TEXT_LINK } from "@/components/link"
import { InlineEmpty, RowsSkeleton, When } from "@/components/page"
import { actorLabel, auditWords, isAuditResponse, readAudit } from "@/lib/audit"
import { RECENT_LINES, historyRequest, historyUrl, type HistoryFilter } from "@/lib/history"
import { TONE_TEXT } from "@/lib/tones"
import type { AuditRow } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The one detail pattern, for a list whose rows are not pages: Tokens,
 * People, Connectors, Activity, a snapshot, a ranking's *Show all*. The
 * shadcn sheet, from the right at 440 px on a computer, from the bottom at
 * up to 90 % of the height on a phone. Its head: the object's name, its
 * state, its actions; its body: every field as keys and values
 * (`SheetFacts`), then *Recent*, the object's last ten lines of Activity,
 * and *All activity*.
 *
 * Its address is the page's: `?token=<id>`, `?person=`, `?event=`,
 * `?connector=` (`useSheet`), so that Back closes it and a link opens it.
 */

// --- The address -----------------------------------------------------------------

/**
 * A sheet addressed by one parameter of the page's address. `open` adds a
 * history entry, so that Back closes the sheet; moving from one row's sheet
 * to another's replaces it. `close` goes back over the entry it added, or,
 * for a sheet that came with the address, takes the parameter off.
 */
export function useSheet(param: string): { id: string | null; open: (id: string) => void; close: () => void } {
  const { params, path, navigate } = useNavigation()
  const id = params.get(param)
  const pushed = useRef(false)

  // Closed by Back, or by a link elsewhere: the entry this page added is gone.
  useEffect(() => {
    if (id === null) pushed.current = false
  }, [id])

  function addressWith(value: string | null) {
    const next = new URLSearchParams(params.toString())
    if (value === null) next.delete(param)
    else next.set(param, value)
    const text = next.toString()
    return `${path}${text === "" ? "" : `?${text}`}`
  }

  return {
    id,
    open: (value) => {
      if (value === id) return
      const replace = id !== null
      navigate(addressWith(value), { replace })
      if (!replace) pushed.current = true
    },
    close: () => {
      if (id === null) return
      if (pushed.current) {
        pushed.current = false
        window.history.back()
        return
      }
      navigate(addressWith(null), { replace: true })
    },
  }
}

/** A phone, read at once: the sheet comes from the bottom there, and must not slide in from the side first. */
function usePhone(): boolean {
  const query = "(max-width: 47.99rem)"
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const change = () => setPhone(media.matches)
    media.addEventListener("change", change)
    return () => media.removeEventListener("change", change)
  }, [])
  return phone
}

// --- The sheet -----------------------------------------------------------------------

export function DetailSheet({
  open,
  onClose,
  title,
  state,
  description,
  actions,
  history,
  children,
}: {
  open: boolean
  onClose: () => void
  /** The object's name, the sheet's title. */
  title: string
  /** Its state beside the title: a `StateLabel`, quiet when fine. */
  state?: ReactNode
  /** A line under the title. */
  description?: ReactNode
  /** Its actions, the row menu's, as buttons; destructive last. */
  actions?: ReactNode
  /** Its Activity: *Recent*, the last ten lines, then *All activity*. No section without it. */
  history?: HistoryFilter
  children?: ReactNode
}) {
  const phone = usePhone()
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side={phone ? "bottom" : "right"}
        className={cn(
          "gap-0 p-0",
          phone ? "max-h-[90svh] rounded-t-xl pb-[env(safe-area-inset-bottom)]" : "data-[side=right]:w-full data-[side=right]:sm:max-w-[27.5rem]",
        )}
      >
        <SheetHeader className="gap-1 border-b px-5 py-4 pr-12">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <SheetTitle className="min-w-0 truncate text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">{title}</SheetTitle>
            {state}
          </div>
          {description !== undefined ? (
            <SheetDescription>{description}</SheetDescription>
          ) : (
            <SheetDescription className="sr-only">Details of {title}</SheetDescription>
          )}
          {actions !== undefined && <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>}
        </SheetHeader>
        <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto px-5 py-4">
          {children}
          {history !== undefined && <SheetRecent filter={history} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** A sheet's section: a mono label over what it holds. */
export function SheetSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="mono-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export type Fact = { label: string; value: ReactNode }

/** Every field as a key and its value, one per 36 px line, ruled like a list. */
export function SheetFacts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] divide-y divide-divider text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="col-span-2 grid grid-cols-subgrid items-baseline gap-x-4 py-2">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 wrap-anywhere">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

type Recent = { state: "loading" } | { state: "failed" } | { state: "ready"; rows: AuditRow[] }

/**
 * The object's last ten lines of Activity, read when the sheet opens, each
 * in Activity's words and its tone when it went wrong; then *All activity*,
 * the same filter on the Activity page.
 */
export function SheetRecent({ filter }: { filter: HistoryFilter }) {
  const { now, offset, sessionExpired } = useData()
  const [recent, setRecent] = useState<Recent>({ state: "loading" })
  const key = historyUrl(filter)
  const serverNow = now + offset

  useEffect(() => {
    let current = true
    const { query, keep } = historyRequest(filter, Date.now())
    setRecent({ state: "loading" })
    void readAudit(query).then(({ status, body }) => {
      if (!current) return
      if (status === 401) return sessionExpired()
      if (status !== 200 || !isAuditResponse(body)) return setRecent({ state: "failed" })
      setRecent({ state: "ready", rows: body.rows.filter((row) => keep(row.action)).slice(0, RECENT_LINES) })
    })
    return () => {
      current = false
    }
    // The filter's address stands for the filter, a new object on every render: one read per object.
  }, [key, sessionExpired])

  return (
    <SheetSection
      title="Recent"
      action={
        <InternalLink href={key} className={cn(TEXT_LINK, "text-xs text-muted-foreground")}>
          All activity
        </InternalLink>
      }
    >
      {recent.state === "loading" ? (
        <div aria-busy="true" aria-label="Loading recent activity" className="-mx-4">
          <RowsSkeleton lines={3} />
        </div>
      ) : recent.state === "failed" ? (
        <InlineEmpty icon={History} className="-mx-4">
          Can't read the activity right now.
        </InlineEmpty>
      ) : recent.rows.length === 0 ? (
        <InlineEmpty icon={History} className="-mx-4">
          Nothing yet.
        </InlineEmpty>
      ) : (
        <ol className="divide-y divide-divider">
          {recent.rows.map((row) => {
            const words = auditWords(row)
            const failed = words.tone === "error" || words.tone === "attention"
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2">
                <span className={cn("min-w-0 text-pretty", failed && cn("font-medium", TONE_TEXT[words.tone]))}>{words.summary}</span>
                <When at={Date.parse(row.at)} serverNow={serverNow} />
                <span className="col-span-2 truncate text-xs text-muted-foreground">{actorLabel(row)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </SheetSection>
  )
}
