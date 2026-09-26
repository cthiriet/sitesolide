import { useId, type ReactNode } from "react"
import {
  CircleX,
  CloudOff,
  Ellipsis,
  LogOut,
  RefreshCw,
  ServerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useData } from "@/components/data"
import { Logo } from "@/components/logo"
import { InternalLink, useNavigation } from "@/components/navigation"
import { useTheme } from "@/components/theme"
import { JUST_NOW_MS, duration, ago } from "@/lib/format"
import { PAGE_TITLE_ID } from "@/lib/pages"
import { TONE_BANNER, TONE_PILL, TONE_DOT, TONE_TEXT, verdictTone, type Tone } from "@/lib/tones"
import type { Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/**
 * The primitives shared by the pages: header, container, panel, empty states,
 * errors, skeletons, statuses. A page does not write its own version of any of
 * them; web/DESIGN.md says when to use what.
 */

/** The content's width and gutters, shared by the header, the banners and the body. */
export const CONTAINER = "mx-auto w-full max-w-6xl px-4 md:px-8"

/**
 * A dialog you type into, on a phone: full width, anchored at the bottom, where
 * the thumb reaches it and where the keyboard does not hide it. Confirmations,
 * with no field, stay centred.
 */
export const INPUT_DIALOG =
  "max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"

// --- Statuses --------------------------------------------------------------------

/**
 * A status: a tone dot and a word, never the colour alone. `point` in dense
 * rows, `pill` for what has to be seen from afar.
 */
export function Status({
  tone,
  shape = "point",
  title,
  className,
  children,
}: {
  tone: Tone
  shape?: "point" | "pill"
  title?: string
  className?: string
  children: ReactNode
}) {
  if (shape === "pill") {
    return (
      <span
        title={title}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium whitespace-nowrap",
          TONE_PILL[tone],
          className,
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
        {children}
      </span>
    )
  }
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        (tone === "attention" || tone === "error") && TONE_TEXT[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
      {children}
    </span>
  )
}

/**
 * A severity's icon. Decorative, unless `label`: it then carries a text for
 * screen readers, the colour alone saying nothing to someone who does not see
 * it.
 */
export function SeverityIcon({
  severity,
  label = false,
  className,
}: {
  severity: Severity
  label?: boolean
  className?: string
}) {
  const error = severity === "error"
  const Icon = error ? CircleX : TriangleAlert
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", error ? "text-destructive" : "text-attention-text", className)}
      />
      {label && <span className="sr-only">{error ? "Error: " : "Warning: "}</span>}
    </>
  )
}

/** The number beside a page or panel title. */
export function Count({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  )
}

// --- Surfaces --------------------------------------------------------------------

/**
 * The container for a page's content, under its header. `narrow` for a form on
 * its own.
 *
 * It is also the `body` query container: a page goes to two columns according
 * to the width of its content, `@4xl/body:`, and not according to the screen's,
 * the expanded sidebar taking 256 px of it. The screen only decides the shell:
 * sidebar or tabs, gutters, bottom margin.
 */
export function PageBody({ narrow = false, className, children }: { narrow?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn(CONTAINER, "@container/body grid gap-6 pt-6 pb-28 md:pb-12", narrow && "max-w-2xl", className)}>
      {children}
    </div>
  )
}

/**
 * A bordered white surface, grouping what is read together. With a title, a
 * header row and its rule. `full` makes the content touch the edges: a table,
 * a divided list.
 */
export function Panel({
  title,
  count,
  description,
  actions,
  full = false,
  id,
  className,
  children,
}: {
  title?: string
  count?: number | string
  description?: ReactNode
  actions?: ReactNode
  full?: boolean
  id?: string
  className?: string
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section
      id={id}
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cn("min-w-0 overflow-hidden rounded-lg border bg-card text-sm text-card-foreground", className)}
    >
      {title !== undefined && (
        <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-4 py-2">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          {count !== undefined && <Count>{count}</Count>}
          {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          {description !== undefined && <p className="basis-full text-xs text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className={cn(!full && "p-4")}>{children}</div>
    </section>
  )
}

// --- States ----------------------------------------------------------------------

/** Nothing to show: the state as the title, and what to do below it. */
export function EmptyState({
  icon: Icon,
  title,
  action,
  compact = false,
  children,
}: {
  icon?: LucideIcon
  title: string
  action?: ReactNode
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <div className={cn("grid justify-items-center gap-1 px-4 text-center", compact ? "py-6" : "py-12")}>
      {Icon !== undefined && <Icon aria-hidden="true" className="mb-2 size-5 text-muted-foreground" />}
      <p className="max-w-full font-medium text-balance wrap-anywhere">{title}</p>
      {children !== undefined && <div className="max-w-md text-sm text-pretty text-muted-foreground">{children}</div>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  )
}

/**
 * A read specific to the page failed, and there is nothing else to show.
 * `compact` inside one panel among others, as on a site's card.
 */
export function ErrorState({
  title,
  onRetry,
  inProgress = false,
  compact = false,
  children,
}: {
  title: string
  onRetry?: () => void
  inProgress?: boolean
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <div role="status">
      <EmptyState
        icon={CloudOff}
        title={title}
        compact={compact}
        action={
          onRetry === undefined ? undefined : (
            <Button variant="outline" onClick={onRetry} disabled={inProgress} className="max-md:h-10">
              {inProgress ? "Retrying…" : "Retry"}
            </Button>
          )
        }
      >
        {children}
      </EmptyState>
    </div>
  )
}

/** A problem that does not stop you reading the page: the previous data stays displayed. */
export function Banner({
  tone,
  icon,
  action,
  children,
}: {
  tone: "attention" | "error"
  icon?: LucideIcon
  action?: ReactNode
  children: ReactNode
}) {
  const Icon = icon ?? (tone === "error" ? CircleX : TriangleAlert)
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm", TONE_BANNER[tone])}
    >
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", TONE_TEXT[tone])} />
      <div className="min-w-0 flex-1 basis-60">{children}</div>
      {action}
    </div>
  )
}

// --- Skeletons -------------------------------------------------------------------

const WIDTHS = ["w-28", "w-36", "w-24", "w-32", "w-20", "w-40"] as const
const TEXT_WIDTHS = ["max-w-md", "max-w-sm", "max-w-lg", "max-w-xs", "max-w-md", "max-w-sm"] as const

/** The rows of a loading list, at the heights of the real ones. */
export function RowsSkeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("divide-y", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex h-11 items-center gap-3 px-4">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className={cn("h-3.5 shrink-0", WIDTHS[index % WIDTHS.length])} />
          <Skeleton className={cn("h-3.5 flex-1", TEXT_WIDTHS[index % TEXT_WIDTHS.length])} />
        </div>
      ))}
    </div>
  )
}

/** A loading panel. */
export function PanelSkeleton({ lines = 4, title = true, className }: { lines?: number; title?: boolean; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      {title && (
        <div className="flex h-11 items-center border-b px-4">
          <Skeleton className="h-3.5 w-24" />
        </div>
      )}
      <RowsSkeleton lines={lines} />
    </div>
  )
}

/**
 * A page's header while the session is being checked: the title is known, the
 * verdict not yet. A site section does not know its site yet.
 */
export function HeaderSkeleton({ title }: { title: string | null }) {
  return (
    <header className="border-b">
      <div className={cn(CONTAINER, "flex min-h-[4.25rem] items-center gap-2.5 py-3")}>
        <Logo className="size-7 md:hidden" />
        {title === null ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <p className="font-display text-[1.375rem] leading-7 font-semibold tracking-tight">{title}</p>
        )}
        <Skeleton className="ml-auto hidden h-6 w-40 md:block" />
        <Skeleton className="ml-auto size-9 md:hidden" />
      </div>
    </header>
  )
}

// --- The page header -------------------------------------------------------------

/** The machine's verdict, which leads to the home page's discrepancies from the other pages. */
function Verdict() {
  const { reading, failure, verdict } = useData()
  const { page } = useNavigation()
  if (reading === null && !failure) return <Skeleton className="h-6 w-28" />
  const pill = (
    <Status tone={verdictTone(verdict)} shape="pill">
      {verdict.label}
    </Status>
  )
  if (page.name === "home") return pill
  return (
    <InternalLink
      href="/"
      className="inline-flex rounded-sm outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {pill}
      <span className="sr-only">, show issues</span>
    </InternalLink>
  )
}

function Age({ short = false }: { short?: boolean }) {
  const { age } = useData()
  if (age === null) return null
  return (
    <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
      {!short && "Updated "}
      {ago(age)}
    </span>
  )
}

function RefreshButton({ className }: { className?: string }) {
  const { inProgress, refresh } = useData()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Refresh"
      title="Refresh"
      aria-busy={inProgress || undefined}
      onClick={refresh}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <RefreshCw className={cn(inProgress && "motion-safe:animate-spin")} />
    </Button>
  )
}

/** On a phone, the theme and the sign-out, which the sidebar carries elsewhere. */
function MobileMenu() {
  const { signOut } = useData()
  const { label, Icon, toggle } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="More" className="size-10 text-muted-foreground hover:text-foreground" />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={toggle} className="h-10">
          <Icon />
          {label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} className="h-10">
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The whole page's problems, under the header: data unreachable or stale. */
function ShellBanners() {
  const { reading, failure, inProgress, age, refresh } = useData()
  const stale = reading !== null && reading.present && reading.stale
  const unreachable = failure && reading !== null
  if (!stale && !unreachable) return null
  return (
    <div className={cn(CONTAINER, "grid gap-2 pt-4")}>
      {unreachable && (
        <Banner
          tone="attention"
          icon={CloudOff}
          action={
            <Button variant="outline" size="sm" onClick={refresh} disabled={inProgress} className="max-md:h-9">
              Retry
            </Button>
          }
        >
          Can't reach the dashboard.{" "}
          {age !== null && age >= JUST_NOW_MS ? `Showing data from ${ago(age)}.` : "Showing the last data received."}
        </Banner>
      )}
      {stale && age !== null && (
        <Banner tone="error">
          The collector hasn't reported for {duration(age)}, so this data may be out of date. Check{" "}
          <code className="font-mono text-xs">systemctl status sitesolide-collector.timer</code> on the server.
        </Banner>
      )}
    </div>
  )
}

/**
 * Every page's header, and its first element: the title, focusable so that
 * focus returns to it after a navigation, the machine's verdict, the age of the
 * data and the refresh control, then the page-wide banners.
 *
 * `actions`: the buttons specific to the page, to the right of the title on a
 * computer, under it on a phone. `breadcrumb`: the breadcrumb up to the page, above
 * the title, inside a site. `afterTitle`: what follows the title on its line,
 * the site switcher on a phone.
 */
export function PageHeader({
  title,
  count,
  breadcrumb,
  afterTitle,
  description,
  actions,
}: {
  title: string
  count?: ReactNode
  breadcrumb?: ReactNode
  afterTitle?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <>
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
        <div className={cn(CONTAINER, "flex flex-wrap items-center gap-x-4 gap-y-2 py-3 md:min-h-[4.25rem]")}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <InternalLink
              href="/"
              aria-label="All sites"
              className="shrink-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden"
            >
              <Logo className="size-7" />
            </InternalLink>
            <div className="grid min-w-0">
              {breadcrumb}
              <div className="flex min-w-0 items-center gap-2">
                <h1
                  id={PAGE_TITLE_ID}
                  tabIndex={-1}
                  className="truncate font-display text-[1.375rem] leading-7 font-semibold tracking-tight outline-none"
                >
                  {title}
                </h1>
                {count !== undefined && <Count>{count}</Count>}
                {afterTitle}
              </div>
            </div>
          </div>

          {actions !== undefined && <div className="hidden items-center gap-2 md:flex">{actions}</div>}

          <div className="hidden items-center gap-3 md:flex">
            <Verdict />
            <Age />
            <RefreshButton className="-mr-2" />
          </div>
          <div className="-mr-2 flex items-center md:hidden">
            <RefreshButton className="size-10" />
            <MobileMenu />
          </div>

          <div className="flex basis-full items-center gap-2 md:hidden">
            <Verdict />
            <Age short />
          </div>
          {description !== undefined && <div className="basis-full text-sm text-muted-foreground">{description}</div>}
          {actions !== undefined && <div className="flex basis-full flex-wrap items-center gap-2 md:hidden">{actions}</div>}
        </div>
      </header>
      <ShellBanners />
    </>
  )
}

// --- The snapshot ----------------------------------------------------------------

/**
 * The three states of a page that needs the snapshot, rendered the same
 * everywhere: loading, dashboard unreachable before any data, snapshot missing
 * or unreadable. `children` only ever receives a readable snapshot.
 */
export function WithSnapshot({
  skeleton,
  children,
}: {
  skeleton: ReactNode
  children: (snapshot: Snapshot) => ReactNode
}) {
  const { reading, failure, inProgress, refresh } = useData()
  if (reading === null) {
    if (!failure) return skeleton
    return (
      <Panel>
        <ErrorState title="Can't reach the dashboard." onRetry={refresh} inProgress={inProgress}>
          The server didn't answer. Check your connection, then try again.
        </ErrorState>
      </Panel>
    )
  }
  if (!reading.present) {
    return (
      <Panel>
        <EmptyState
          icon={ServerOff}
          title="No snapshot to show"
          action={
            <Button variant="outline" onClick={refresh} disabled={inProgress} className="max-md:h-10">
              Retry
            </Button>
          }
        >
          {reading.reason}
        </EmptyState>
      </Panel>
    )
  }
  return <>{children(reading.snapshot)}</>
}

/** The service did not answer the session check: nothing can be displayed. */
export function UnreachableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6">
      <div className="grid max-w-xs justify-items-center gap-2 text-center">
        <Logo className="mb-3 size-10" />
        <h1 className="font-display text-lg font-semibold tracking-tight">Can't reach the dashboard.</h1>
        <p className="text-sm text-muted-foreground">
          The server didn't answer. The page tries again every few seconds; check your connection if it lasts.
        </p>
        <Button onClick={onRetry} className="mt-3 h-10 px-4">
          Retry
        </Button>
      </div>
    </main>
  )
}
