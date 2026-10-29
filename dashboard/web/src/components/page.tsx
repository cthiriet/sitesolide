import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react"
import {
  CircleCheck,
  CircleX,
  CloudOff,
  Ellipsis,
  History,
  Info,
  LogOut,
  RefreshCw,
  ServerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { useData } from "@/components/data"
import { Logo } from "@/components/logo"
import { InternalLink, useNavigation } from "@/components/navigation"
import { useOptionalSecretsActions } from "@/components/secrets-actions"
import { useTheme } from "@/components/theme"
import { UnlockedPill } from "@/components/unlock"
import { ABSENT, JUST_NOW_MS, dateTime, duration, ago } from "@/lib/format"
import { historyUrl, type HistoryFilter } from "@/lib/history"
import { PAGE_TITLE_ID } from "@/lib/pages"
import { TONE_BANNER, TONE_HALO, TONE_PILL, TONE_DOT, TONE_TEXT, verdictTone, type Tone } from "@/lib/tones"
import type { Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"
import { VERSION } from "@/lib/version"

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
          "inline-flex h-6 shrink-0 items-center gap-2 rounded-md border px-2 text-xs font-medium whitespace-nowrap",
          TONE_PILL[tone],
          className,
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], TONE_HALO[tone], "ring-2")} />
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
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone], TONE_HALO[tone])} />
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

/**
 * A row's state, quiet when fine: nothing at all for `ok`, which the page's
 * verdict says once; a muted word for `neutral`, a piece of information; the
 * word in its tone, 13 px, for `attention` and `error`. `more` adds the
 * "+2" chip of the states not shown, whose tooltip, `title`, lists every
 * message in full. A fine row carries no status word, a row in trouble its
 * word and the severity icon in its gutter (`SeverityGutter`), so that colour
 * never says anything alone.
 */
export function StateLabel({
  tone,
  more = 0,
  title,
  className,
  children,
}: {
  tone: Tone
  more?: number
  title?: string
  className?: string
  children: ReactNode
}) {
  if (tone === "ok") return null
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[0.8125rem] whitespace-nowrap",
        tone === "neutral" ? "text-muted-foreground" : cn("font-medium", TONE_TEXT[tone]),
        className,
      )}
    >
      <span className="truncate">{children}</span>
      {more > 0 && <Count className="h-[1.125rem] px-1 text-[0.6875rem]">+{more}</Count>}
    </span>
  )
}

/**
 * When something happened, as an age, its date and time on hover. A time that
 * does not read shows a hyphen: Date and Intl throw on NaN, and an unreadable
 * row must not bring the page down.
 */
export function When({ at, serverNow }: { at: number | null; serverNow: number }) {
  if (at === null || !Number.isFinite(at)) return <span className="text-muted-foreground">{ABSENT}</span>
  return (
    <time dateTime={new Date(at).toISOString()} title={dateTime(at)} className="whitespace-nowrap text-muted-foreground tabular-nums">
      {ago(serverNow - at)}
    </time>
  )
}

/** The number beside a page or panel title: the landing page's mono chip. */
export function Count({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border bg-cell px-1.5 font-mono text-xs text-secondary-foreground tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A segmented control's frame: a well sunk below the page, the segments laid in it. */
export const SEGMENTED = "rounded-lg bg-sunk p-0.5 shadow-well"

/**
 * One segment of a segmented control, a toggle button that reads and is
 * reached on its own: the chosen one rises out of the well, on the raised
 * surface with its hairline and its soft lift, in the `strong` text of the
 * sidebar's current page.
 */
export function Segment({ selected, className, ...props }: ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-md px-2.5 text-[0.8125rem] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-[1.875rem]",
        selected
          ? "bg-popover font-medium text-strong shadow-raised ring-1 ring-border"
          : "text-secondary-foreground hover:bg-muted hover:text-strong",
        className,
      )}
      {...props}
    />
  )
}

// --- Surfaces --------------------------------------------------------------------

/**
 * The container for a page's content, under its header. `narrow` for a form on
 * its own.
 *
 * It is also the `body` query container: a page goes to two columns according
 * to the width of its content, `@4xl/body:`, and not according to the screen's,
 * the expanded sidebar taking 232 px of it. The screen only decides the shell:
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
 * A panel, grouping what is read together: the card's surface a step above
 * the paper, its hairline and its soft shadow. With a title, a header row and
 * its rule. `full` makes the content touch the edges: a table, a divided list.
 */
export function Panel({
  title,
  count,
  afterTitle,
  description,
  actions,
  full = false,
  id,
  className,
  children,
}: {
  title?: string
  count?: number | string
  /** What follows the title and its count on their line: the (i) of a panel that explains itself. */
  afterTitle?: ReactNode
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
      // `clip` and not `hidden`: it rounds the corners without making the panel
      // a scroll container, so that a table's head can stick under the page header.
      className={cn("min-w-0 overflow-clip rounded-xl border bg-card text-sm text-card-foreground shadow-panel", className)}
    >
      {title !== undefined && (
        <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-4 py-2">
          <h2 id={titleId} className="text-heading">
            {title}
          </h2>
          {count !== undefined && <Count>{count}</Count>}
          {afterTitle}
          {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          {description !== undefined && <p className="basis-full text-xs text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className={cn(!full && "p-4")}>{children}</div>
    </section>
  )
}

// --- States ----------------------------------------------------------------------

/** A feature of the landing page, in its tint and its ink: kept to what is that feature's own. */
export type Feature = "share" | "signin" | "recover"

const TILE_FEATURE: Record<Feature | "neutral", string> = {
  neutral: "bg-tile text-secondary-foreground shadow-[inset_0_1px_0_var(--tile-hi),inset_0_0_0_1px_var(--border)]",
  share: "bg-share-tint text-share-ink shadow-[inset_0_1px_0_var(--tile-hi),inset_0_0_0_1px_color-mix(in_srgb,var(--share-ink)_18%,transparent)]",
  signin: "bg-signin-tint text-signin-ink shadow-[inset_0_1px_0_var(--tile-hi),inset_0_0_0_1px_color-mix(in_srgb,var(--signin-ink)_18%,transparent)]",
  recover: "bg-recover-tint text-recover-ink shadow-[inset_0_1px_0_var(--tile-hi),inset_0_0_0_1px_color-mix(in_srgb,var(--recover-ink)_18%,transparent)]",
}

const TILE_SIZE = {
  40: "size-10 rounded-lg [&>svg]:size-5",
  32: "size-8 rounded-md [&>svg]:size-4",
  24: "size-6 rounded-sm [&>svg]:size-3.5",
} as const

/**
 * An icon on its tile, the landing page's: a square a step off its surface,
 * ringed with the hairline, a highlight along its top. Neutral, or in a
 * feature's tint and ink. It always labels something, the title beside or
 * under it, and says nothing to a screen reader itself.
 */
export function Tile({
  icon: Icon,
  feature,
  size = 40,
  className,
}: {
  icon: LucideIcon
  feature?: Feature
  size?: keyof typeof TILE_SIZE
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid shrink-0 place-items-center", TILE_SIZE[size], TILE_FEATURE[feature ?? "neutral"], className)}
    >
      <Icon strokeWidth={1.75} />
    </span>
  )
}

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
      {Icon !== undefined && <Tile icon={Icon} className="mb-2" />}
      <p className="max-w-full font-medium text-balance wrap-anywhere">{title}</p>
      {children !== undefined && <div className="max-w-md text-sm text-pretty text-muted-foreground">{children}</div>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  )
}

/**
 * Empty is small: inside a panel, one 44 px line, a 16 px icon, the state,
 * and at most one action, a quiet button or link. "No token yet." with *New
 * token*. The tiled `EmptyState` stays for a page with nothing at all; a
 * section with nothing in it and nothing to ask disappears instead.
 */
export function InlineEmpty({
  icon: Icon,
  action,
  className,
  children,
}: {
  icon: LucideIcon
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 text-sm text-muted-foreground", className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 text-pretty">{children}</p>
      {action !== undefined && <div className="flex items-center">{action}</div>}
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

/**
 * A read asked for again from a *Retry* button, `retrying` while it runs so
 * that the button says so. What the read finds is its own to show.
 */
export function useRetry(read: () => Promise<unknown>): { retrying: boolean; retry: () => void } {
  const [retrying, setRetrying] = useState(false)
  function retry() {
    setRetrying(true)
    void read().finally(() => setRetrying(false))
  }
  return { retrying, retry }
}

/** A form's refusal, under its field or above its buttons, read out as it appears; nothing while it is empty. */
export function FormError({ id, children }: { id?: string; children: string }) {
  if (children === "") return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
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
    <div aria-hidden="true" className={cn("divide-y divide-divider", className)}>
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
    <div aria-busy="true" aria-label="Loading" className={cn("overflow-hidden rounded-xl border bg-card shadow-panel", className)}>
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
          <p className="text-title">{title}</p>
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
      className="inline-flex rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
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

/** On a phone, the theme, the sign-out and the release, which the sidebar carries elsewhere. */
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
        <DropdownMenuSeparator />
        <p className="truncate px-1.5 py-1 font-mono text-[0.6875rem] text-muted-foreground max-md:text-xs" title={`sitesolide ${VERSION}`}>
          {VERSION}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The whole page's problems, under the header: data unreachable or stale;
 * and what became of an unlock, which every page may ask for: a person's
 * that came back refused, a lock refused, or what to press again once a
 * person's came back unlocked.
 */
function ShellBanners() {
  const { reading, failure, inProgress, age, refresh } = useData()
  const actions = useOptionalSecretsActions()
  const stale = reading !== null && reading.present && reading.stale
  const unreachable = failure && reading !== null
  const unlockNotice = actions?.unlockNotice ?? null
  const lockError = actions?.lockError ?? ""
  const resumeNote = actions?.resumeNote ?? null
  if (!stale && !unreachable && unlockNotice === null && lockError === "" && resumeNote === null) return null
  return (
    <div className={cn(CONTAINER, "grid gap-2 pt-4")}>
      {unlockNotice !== null && <Banner tone="error">{unlockNotice}</Banner>}
      {lockError !== "" && <Banner tone="error">Couldn't lock changes. {lockError}</Banner>}
      {resumeNote !== null && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-ok-text" />
          {resumeNote}
        </p>
      )}
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
 * A page's intro, read on demand: the (i) beside the title opens it. What
 * the page is for and what it never shows, the paragraph a page used to open
 * with, kept whole and moved out of the way of its list.
 */
function IntroButton({ title, children }: { title: string; children: ReactNode }) {
  return <InfoButton label={`About ${title}`}>{children}</InfoButton>
}

/** The (i) and its popover, for a page's intro or a panel that explains itself: `label` names it to a screen reader. */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="shrink-0 text-muted-foreground hover:text-foreground max-md:size-9"
          />
        }
      >
        <Info />
      </PopoverTrigger>
      <PopoverContent className="grid gap-2 text-pretty text-secondary-foreground">{children}</PopoverContent>
    </Popover>
  )
}

/**
 * The quiet way to a page's history: Activity, narrowed to this object
 * (lib/history.ts). A ghost button with its clock; the icon alone on a phone.
 */
export function HistoryLink({ filter, className }: { filter: HistoryFilter; className?: string }) {
  return (
    <InternalLink
      href={historyUrl(filter)}
      aria-label="History"
      title="See this in Activity"
      className={cn(buttonVariants({ variant: "ghost" }), "text-muted-foreground hover:text-foreground max-md:size-10 max-md:px-0", className)}
    >
      <History />
      <span aria-hidden="true" className="max-md:hidden">
        History
      </span>
    </InternalLink>
  )
}

/**
 * The header's height, as `--page-header` on the root: a table's sticky head
 * sits right under it, whatever the header wraps to.
 */
function useHeaderHeight() {
  const header = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = header.current
    if (element === null || typeof ResizeObserver === "undefined") return
    const root = document.documentElement
    const observer = new ResizeObserver(() => root.style.setProperty("--page-header", `${element.offsetHeight}px`))
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--page-header")
    }
  }, [])
  return header
}

/**
 * Every page's header, and its first element. On the left the breadcrumb,
 * the title, focusable so that focus returns to it after a navigation, its
 * count and its (i); on the right the page's one primary action, its History
 * link, the unlocked pill while changes are unlocked, then the machine's
 * verdict, the age of the data and the refresh control. The page-wide
 * banners follow it.
 *
 * - `count`: the number the page lists, the same the sidebar and the rows count.
 * - `intro`: the page's intro paragraph, behind the (i) beside the title.
 * - `actions`: the page's own controls, one primary among them at most; on
 *   a phone, under the title beside the verdict.
 * - `history`: what the History link narrows Activity to; no link without it.
 * - `breadcrumb`: the path up to the page, above the title, inside a site.
 * - `afterTitle`: what follows the title on its line, the site switcher on a phone.
 * - `description`: a line under the title, a site's state and address on its Overview.
 */
export function PageHeader({
  title,
  count,
  intro,
  breadcrumb,
  afterTitle,
  description,
  actions,
  history,
  wide = false,
}: {
  title: string
  count?: ReactNode
  intro?: ReactNode
  breadcrumb?: ReactNode
  afterTitle?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  history?: HistoryFilter
  /** Aligned on a body that takes the whole width, a canvas's. */
  wide?: boolean
}) {
  const header = useHeaderHeight()
  const pageActions =
    actions === undefined && history === undefined ? null : (
      <>
        {actions}
        {history !== undefined && <HistoryLink filter={history} />}
      </>
    )
  return (
    <>
      <header ref={header} className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
        <div className={cn(CONTAINER, "flex flex-wrap items-center gap-x-4 gap-y-2 py-3 md:min-h-[4.25rem]", wide && "max-w-none")}>
          {/* From md, its natural width decides the line break: the controls go under the title before it is cut. */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5 md:basis-auto">
            <InternalLink
              href="/"
              aria-label="All sites"
              className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
            >
              <Logo className="size-7" />
            </InternalLink>
            <div className="grid min-w-0">
              {breadcrumb}
              <div className="flex min-w-0 items-center gap-2">
                <h1
                  id={PAGE_TITLE_ID}
                  tabIndex={-1}
                  className="truncate text-title outline-none"
                >
                  {title}
                </h1>
                {count !== undefined && <Count>{count}</Count>}
                {intro !== undefined && <IntroButton title={title}>{intro}</IntroButton>}
                {afterTitle}
              </div>
            </div>
          </div>

          {/* One group, so that on a narrow content it goes under the title whole, on the right. */}
          <div className="ml-auto hidden flex-wrap items-center justify-end gap-x-4 gap-y-2 md:flex">
            {pageActions !== null && <div className="flex items-center gap-1.5">{pageActions}</div>}
            <div className="flex items-center gap-3">
              <UnlockedPill />
              <Verdict />
              <Age />
              <RefreshButton className="-mr-2" />
            </div>
          </div>
          <div className="-mr-2 flex items-center md:hidden">
            <RefreshButton className="size-10" />
            <MobileMenu />
          </div>

          {/* On a phone, the actions share the verdict's row when they fit, rather than taking one of their own. */}
          <div className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-2 md:hidden">
            <Verdict />
            <Age short />
            <UnlockedPill />
            {pageActions !== null && <div className="ml-auto flex flex-wrap items-center gap-1.5">{pageActions}</div>}
          </div>
          {description !== undefined && <div className="basis-full text-sm text-muted-foreground">{description}</div>}
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
        <h1 className="text-title">Can't reach the dashboard.</h1>
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
