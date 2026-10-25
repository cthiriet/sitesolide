import { useId, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { Ellipsis } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { InternalLink, useNavigation } from "@/components/navigation"
import { SeverityIcon } from "@/components/page"
import { INTERACTIVE, rowClickOutcome } from "@/lib/rows"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/**
 * The one list pattern: one line per item, 44 px on a computer (40 when
 * `dense`, for Activity and Backups), two lines of 56 px below the width the
 * columns need, decided by the table's own width and never the screen's.
 * Name first, at most four short columns, machine strings in muted mono,
 * numbers right-aligned and tabular. A sticky head under the page header. A
 * row in trouble carries the severity icon in a 28 px gutter, a fine one
 * nothing. A click anywhere on the row opens its page or its sheet; the
 * name stays the real link or button. At most one action in the row, the
 * page's job; everything else in the row menu, destructive last.
 *
 * The table draws no panel of its own: put it in a `Panel full`.
 *
 * In the two-line layout each column goes where its `slot` says: `primary`
 * top left, `state` top right, `meta` bottom left, `time` bottom right,
 * `hide` nowhere; the menu sits at the right across both lines.
 */

/** Where a cell goes when the row takes two lines. */
export type Slot = "primary" | "state" | "meta" | "time" | "hide"

export type Column<Row> = {
  /** React's key, and the column's identity. */
  key: string
  /** The column head, in mono capitals. `srHead` instead for a column whose head would only repeat its icons. */
  head: string
  srHead?: string
  /** Its track in the one-line layout: `"minmax(180px,1.2fr)"`, `"96px"`. */
  width: string
  /** `end` for numbers and ages, right-aligned; `center` for an icon. */
  align?: "start" | "end" | "center"
  /** Where it goes in the two-line layout; `meta` when unsaid. */
  slot?: Slot
  cell: (row: Row) => ReactNode
  className?: string
}

/** The container widths under which a table takes two lines per row. */
export type NarrowBelow = "36rem" | "42rem" | "48rem" | "56rem"

/**
 * The classes of the one-line layout, per threshold, written out in full:
 * Tailwind only generates the classes it reads in the source. `quiet` is
 * the second line's, small and muted, under the threshold alone.
 */
const WIDE: Readonly<Record<NarrowBelow, Record<"head" | "row" | "dense" | "cell" | "gutter" | "split" | "hidden" | "meta" | "pad" | "menu" | "quiet", string>>> = {
  "36rem": {
    head: "@xl/table:grid",
    row: "@xl/table:grid @xl/table:grid-cols-(--table-columns) @xl/table:min-h-11 @xl/table:gap-x-0 @xl/table:py-0 @xl/table:pr-2 @xl/table:pl-4",
    dense: "@xl/table:min-h-10",
    cell: "@xl/table:order-none @xl/table:flex @xl/table:px-3",
    gutter: "@xl/table:static @xl/table:h-auto",
    split: "@xl/table:hidden",
    hidden: "@xl/table:flex",
    meta: "@xl/table:before:content-none",
    pad: "@xl/table:pl-0",
    menu: "@xl/table:static @xl/table:translate-y-0 @xl/table:justify-center",
    quiet: "@max-xl/table:text-xs @max-xl/table:text-muted-foreground",
  },
  "42rem": {
    head: "@2xl/table:grid",
    row: "@2xl/table:grid @2xl/table:grid-cols-(--table-columns) @2xl/table:min-h-11 @2xl/table:gap-x-0 @2xl/table:py-0 @2xl/table:pr-2 @2xl/table:pl-4",
    dense: "@2xl/table:min-h-10",
    cell: "@2xl/table:order-none @2xl/table:flex @2xl/table:px-3",
    gutter: "@2xl/table:static @2xl/table:h-auto",
    split: "@2xl/table:hidden",
    hidden: "@2xl/table:flex",
    meta: "@2xl/table:before:content-none",
    pad: "@2xl/table:pl-0",
    menu: "@2xl/table:static @2xl/table:translate-y-0 @2xl/table:justify-center",
    quiet: "@max-2xl/table:text-xs @max-2xl/table:text-muted-foreground",
  },
  "48rem": {
    head: "@3xl/table:grid",
    row: "@3xl/table:grid @3xl/table:grid-cols-(--table-columns) @3xl/table:min-h-11 @3xl/table:gap-x-0 @3xl/table:py-0 @3xl/table:pr-2 @3xl/table:pl-4",
    dense: "@3xl/table:min-h-10",
    cell: "@3xl/table:order-none @3xl/table:flex @3xl/table:px-3",
    gutter: "@3xl/table:static @3xl/table:h-auto",
    split: "@3xl/table:hidden",
    hidden: "@3xl/table:flex",
    meta: "@3xl/table:before:content-none",
    pad: "@3xl/table:pl-0",
    menu: "@3xl/table:static @3xl/table:translate-y-0 @3xl/table:justify-center",
    quiet: "@max-3xl/table:text-xs @max-3xl/table:text-muted-foreground",
  },
  "56rem": {
    head: "@4xl/table:grid",
    row: "@4xl/table:grid @4xl/table:grid-cols-(--table-columns) @4xl/table:min-h-11 @4xl/table:gap-x-0 @4xl/table:py-0 @4xl/table:pr-2 @4xl/table:pl-4",
    dense: "@4xl/table:min-h-10",
    cell: "@4xl/table:order-none @4xl/table:flex @4xl/table:px-3",
    gutter: "@4xl/table:static @4xl/table:h-auto",
    split: "@4xl/table:hidden",
    hidden: "@4xl/table:flex",
    meta: "@4xl/table:before:content-none",
    pad: "@4xl/table:pl-0",
    menu: "@4xl/table:static @4xl/table:translate-y-0 @4xl/table:justify-center",
    quiet: "@max-4xl/table:text-xs @max-4xl/table:text-muted-foreground",
  },
}

/** The order of each slot in the two-line layout's flex: the first line, a break, the second. */
const SLOT_ORDER: Readonly<Record<Exclude<Slot, "hide">, string>> = {
  primary: "order-1 min-w-0 flex-1",
  state: "order-2 shrink-0",
  meta: "order-4 min-w-0",
  time: "order-5 ml-auto shrink-0",
}

const ALIGN: Readonly<Record<NonNullable<Column<unknown>["align"]>, string>> = {
  start: "justify-start text-left",
  end: "justify-end text-right tabular-nums",
  center: "justify-center",
}

/** The severity gutter's track, and the menu's. */
const GUTTER = "28px"
const MENU = "44px"

/**
 * The 28 px gutter at a row's left edge: the severity icon when the row is in
 * trouble, with its word for screen readers, and nothing when it is fine.
 * The vertical line the eye scans for problems.
 */
export function SeverityGutter({ severity, className }: { severity: Severity | null; className?: string }) {
  return (
    <span className={cn("flex w-7 shrink-0 items-center", className)}>
      {severity !== null && <SeverityIcon severity={severity} label />}
    </span>
  )
}

export function DataTable<Row>({
  label,
  caption,
  rows,
  rowKey,
  columns,
  severity,
  rowHref,
  onRowClick,
  menu,
  dense = false,
  narrowBelow = "42rem",
  selected = null,
  empty,
  foot,
  heading,
  className,
}: {
  /** The table's name, for screen readers: "Tokens". */
  label: string
  /** What a screen reader hears after the name: the order, the filters. */
  caption?: string
  rows: readonly Row[]
  rowKey: (row: Row) => string
  columns: readonly Column<Row>[]
  /** A row's trouble, for the gutter; the gutter exists only with this. */
  severity?: (row: Row) => Severity | null
  /** A row that is a page: its address. Cmd, Ctrl and the middle button open it in a new tab. */
  rowHref?: (row: Row) => string
  /** A row whose details are a sheet: opens it. */
  onRowClick?: (row: Row) => void
  /** The row's `RowMenu`, in a last 44 px column. */
  menu?: (row: Row) => ReactNode
  /** 40 px rows, for Activity and Backups. */
  dense?: boolean
  /** The container width under which rows take two lines. */
  narrowBelow?: NarrowBelow
  /** The key of the row whose sheet is open, tinted as the current page is. */
  selected?: string | null
  /** In place of the rows when there are none: an `InlineEmpty`. */
  empty?: ReactNode
  /** A last line under the rows: "Show 1 revoked or expired", "Load older". */
  foot?: ReactNode
  /**
   * A sticky line in place of the column heads, at every width, for a list
   * cut into groups: one table per group, its heading pushed up by the
   * next one's (Activity's days). The heads stay, for screen readers.
   */
  heading?: ReactNode
  className?: string
}) {
  const { navigate } = useNavigation()
  const captionId = useId()
  const wide = WIDE[narrowBelow]
  const gutter = severity !== undefined
  const tracks = [...(gutter ? [GUTTER] : []), ...columns.map((column) => column.width), ...(menu !== undefined ? [MENU] : [])]
  const style = { "--table-columns": tracks.join(" ") } as CSSProperties
  const clickable = rowHref !== undefined || onRowClick !== undefined
  // The second and later meta cells take a dot before them on the second line, never in the columns.
  const metaIndex = new Map<string, number>()
  for (const column of columns) if ((column.slot ?? "meta") === "meta") metaIndex.set(column.key, metaIndex.size)

  function follow(row: Row, event: MouseEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null
    const interactive = target !== null && target.closest(INTERACTIVE) !== null
    const outcome = rowClickOutcome(event, interactive, window.getSelection()?.toString() ?? "")
    if (outcome === null) return
    if (rowHref !== undefined) {
      const href = rowHref(row)
      if (outcome === "page") navigate(href)
      else window.open(href, "_blank", "noopener")
      return
    }
    // A sheet has no tab of its own: the middle button does nothing, Cmd and Ctrl open it here.
    if (event.button === 0) onRowClick?.(row)
  }

  const cellClass = (column: Column<Row>, index: number) => {
    const slot = column.slot ?? "meta"
    return cn(
      "min-w-0 items-center gap-2",
      slot === "hide" ? "hidden" : cn("flex", SLOT_ORDER[slot]),
      slot === "hide" && wide.hidden,
      (slot === "meta" || slot === "time") && wide.quiet,
      wide.cell,
      index === 0 && wide.pad,
      ALIGN[column.align ?? "start"],
      slot === "meta" && (metaIndex.get(column.key) ?? 0) > 0 && cn("before:mr-2 before:text-faint before:content-['·']", wide.meta),
      column.className,
    )
  }

  return (
    <div
      role="table"
      aria-label={label}
      aria-describedby={caption === undefined ? undefined : captionId}
      className={cn("@container/table text-sm", className)}
      style={style}
    >
      {caption !== undefined && (
        <span id={captionId} className="sr-only">
          {caption}
        </span>
      )}
      {rows.length === 0 ? (
        empty
      ) : (
        <>
          {heading !== undefined && (
            <div aria-hidden="true" className="sticky top-[var(--page-header,0px)] z-10 flex h-9 items-center border-b bg-cell px-4 mono-label">
              {heading}
            </div>
          )}
          <div role="rowgroup" className={cn(heading !== undefined ? "sr-only" : cn("sticky top-[var(--page-header,0px)] z-10 hidden", wide.head))}>
            <div role="row" className="grid h-10 grid-cols-(--table-columns) items-center border-b bg-cell pr-2 pl-4">
              {/* The cell takes its track; only its word is hidden. */}
              {gutter && (
                <span role="columnheader">
                  <span className="sr-only">Issue</span>
                </span>
              )}
              {columns.map((column, index) => (
                <span
                  key={column.key}
                  role="columnheader"
                  className={cn("flex min-w-0 px-3 mono-label", index === 0 && "pl-0", ALIGN[column.align ?? "start"])}
                >
                  {column.srHead !== undefined ? <span className="sr-only">{column.srHead}</span> : <span className="truncate">{column.head}</span>}
                </span>
              ))}
              {menu !== undefined && (
                <span role="columnheader">
                  <span className="sr-only">Actions</span>
                </span>
              )}
            </div>
          </div>
          <div role="rowgroup" className="divide-y divide-divider">
            {rows.map((row) => {
              const key = rowKey(row)
              const trouble = severity?.(row) ?? null
              return (
                <div
                  key={key}
                  role="row"
                  data-selected={selected === key || undefined}
                  onClick={clickable ? (event) => follow(row, event) : undefined}
                  onAuxClick={rowHref !== undefined ? (event) => follow(row, event) : undefined}
                  className={cn(
                    "group/row relative flex min-h-14 flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2",
                    gutter && "pl-11",
                    menu !== undefined && "pr-12",
                    wide.row,
                    dense && wide.dense,
                    clickable && "cursor-pointer hover:bg-muted/45",
                    "data-selected:bg-highlight",
                  )}
                >
                  {gutter && (
                    <span role="cell" className={cn("absolute top-0 left-4 flex h-9 items-center", wide.gutter)}>
                      <SeverityGutter severity={trouble} />
                    </span>
                  )}
                  {columns.map((column, index) => (
                    <span key={column.key} role="cell" className={cellClass(column, index)}>
                      {column.cell(row)}
                    </span>
                  ))}
                  {/* The break between the two lines: the meta and the time start the second. */}
                  <span aria-hidden="true" className={cn("order-3 h-0 basis-full", wide.split)} />
                  {/* On two lines, the menu sits across both at the right, so that its 40 px do not make the second line taller. */}
                  {menu !== undefined && (
                    <span role="cell" className={cn("absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center justify-end", wide.menu)}>
                      {menu(row)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
      {foot !== undefined && <div className="border-t px-4 py-2">{foot}</div>}
    </div>
  )
}

/**
 * A cell's text that may not fit: cut with an ellipsis, whole in its
 * tooltip. A cell is a flex box, so text that has to truncate sits in this
 * rather than bare in the cell.
 */
export function CellText({ title, className, children }: { title?: string; className?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("min-w-0 truncate", className)}>
      {children}
    </span>
  )
}

/**
 * A row's name when the row is a page: the real link, for the keyboard and
 * for screen readers, underlined faintly at rest and fully under the
 * pointer, anywhere on the row.
 */
export function RowLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <InternalLink
      href={href}
      className={cn(
        "min-w-0 truncate rounded-sm font-medium text-strong underline decoration-foreground/20 underline-offset-4 outline-none group-hover/row:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </InternalLink>
  )
}

/**
 * A row's name when its details are a sheet: the button that opens it, the
 * same action as a click on the row.
 */
export function RowButton({ onClick, className, children }: { onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-w-0 truncate rounded-sm text-left font-medium text-strong underline decoration-transparent underline-offset-4 outline-none group-hover/row:decoration-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * The row menu: a 32 px ghost "..." at the row's end, 40 px on a phone. Its
 * items, in this order: where to go (`RowMenuLink`), what to copy, the
 * writes (`WriteMenuItem` from components/unlock.tsx), and last, under a
 * `DropdownMenuSeparator`, the destructive one, `variant="destructive"`,
 * still confirmed. Each names its object: *Revoke token*, *Remove from every
 * project*.
 */
export function RowMenu({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            className={cn("text-muted-foreground hover:text-foreground max-md:size-10", className)}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A row menu's way somewhere: a dashboard page, or a site's address in a new tab. */
export function RowMenuLink({ href, external = false, children }: { href: string; external?: boolean; children: ReactNode }) {
  return (
    <DropdownMenuItem
      render={external ? <a href={href} target="_blank" rel="noopener noreferrer" /> : <InternalLink href={href} />}
      className="h-9"
    >
      {children}
    </DropdownMenuItem>
  )
}
