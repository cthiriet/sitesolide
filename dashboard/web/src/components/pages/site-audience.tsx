import { ChartNoAxesColumn } from "lucide-react"
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Button } from "@/components/ui/button"
import { Command } from "@/components/copy"
import { useData } from "@/components/data"
import { DetailSheet, useSheet } from "@/components/detail-sheet"
import { Banner, InlineEmpty, Panel, PanelSkeleton } from "@/components/page"
import { SitePage } from "@/components/site"
import {
  METRIC_UNITS,
  RANKING_GROUPS,
  TOP_ROWS,
  axisCeiling,
  dayValue,
  emptyCurve,
  figures,
  formatMetric,
  formatNumber,
  groupTabs,
  longDay,
  rankingById,
  rankingLabel,
  rowShare,
  shortDay,
  type Metric,
  type RankingEntry,
  type RankingGroup,
} from "@/lib/audience"
import { ago } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Audience, DayCount, Measure, Row, Site } from "@/lib/types"

/**
 * The tag to paste, the same for every site: the script reads its own host.
 *
 * The measurement service is a project of the machine like any other, served on
 * `analytics.<zone>`: the zone comes from the reading, never from a constant,
 * otherwise this dashboard would display another installation's address.
 */
function tag(zone: string): string {
  return `<script defer src="https://analytics.${zone}/a.js"></script>`
}

// --- The chart -----------------------------------------------------------------------

/** The plot's height on every screen, in CSS pixels: the chart no longer grows with the panel's width. */
const PLOT_HEIGHT = 220
/** Room above the highest value for the line's stroke and the end dot. */
const PLOT_TOP = 8
/** The drawing's own width: the SVG stretches it to the panel, its strokes kept at their pixels. */
const DRAW_WIDTH = 1000

/**
 * One series per day, in hand-written SVG, with a crosshair that snaps to
 * the nearest day and its tooltip.
 *
 * **One series, and that is a choice.** Visits, views and pages per visit
 * are three scales: drawn together they would need two axes, so each figure
 * of the head is a tab that draws its own. The plot keeps its 220 px; the
 * figures and dates are text beside it, never text inside it, where they
 * would scale with the panel's width (DESIGN.md, 2.3).
 *
 * The arrow keys walk the days from the keyboard, and a table carries every
 * day for a screen reader. No library: a few hundred bytes of path beat one
 * more dependency in a bundle the VM only receives as HTML and JS.
 */
function Curve({ days, metric, label }: { days: readonly DayCount[]; metric: Metric; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const values = days.map((day) => dayValue(day, metric))
  const ceiling = axisCeiling(Math.max(0, ...values.map((value) => value ?? 0)), metric !== "pages")
  const plot = PLOT_HEIGHT - PLOT_TOP - 1
  const share = (index: number) => (days.length <= 1 ? 0.5 : index / (days.length - 1))
  const x = (index: number) => share(index) * DRAW_WIDTH
  const y = (value: number) => PLOT_TOP + plot - (value / ceiling) * plot
  const percent = (index: number) => `${(share(index) * 100).toFixed(3)}%`

  // A day with no value breaks the line rather than draw a fall to zero.
  const segments: { index: number; value: number }[][] = []
  values.forEach((value, index) => {
    if (value === null) return
    const previous = segments.at(-1)
    if (previous !== undefined && previous.at(-1)?.index === index - 1) previous.push({ index, value })
    else segments.push([{ index, value }])
  })
  const base = (PLOT_TOP + plot).toFixed(1)
  const line = (segment: { index: number; value: number }[]) =>
    segment.map(({ index, value }) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ")

  const graduations = [0, ceiling / 2, ceiling]
  // First, middle, last: thirty dates would not fit, and three place the window.
  const marks = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
  const last = values.findLastIndex((value) => value !== null)
  const shown = hover ?? null
  const shownValue = shown === null ? null : (values[shown] ?? null)
  const unit = METRIC_UNITS[metric]

  function nearest(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || days.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    setHover(Math.round(ratio * (days.length - 1)))
  }

  function walk(event: KeyboardEvent<HTMLDivElement>) {
    const current = hover ?? last
    const next =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? days.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    setHover(Math.min(days.length - 1, Math.max(0, next)))
  }

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs text-muted-foreground tabular-nums">
      {/* The figures, each level with its rule; the widest, invisible, sizes the column. */}
      {/* Its least width keeps the plot in place from one tab to the next. */}
      <div aria-hidden="true" className="relative min-w-[2.25rem] text-right" style={{ height: PLOT_HEIGHT }}>
        <span className="invisible">{formatMetric(ceiling, metric)}</span>
        {graduations.map((value) => (
          <span key={value} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: y(value) }}>
            {formatMetric(value, metric)}
          </span>
        ))}
      </div>

      <div
        tabIndex={0}
        role="group"
        aria-label={`${label} per day. Use the arrow keys to read each day.`}
        onPointerMove={nearest}
        onPointerDown={nearest}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((current) => current ?? last)}
        onBlur={() => setHover(null)}
        onKeyDown={walk}
        className="relative touch-pan-y rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
        style={{ height: PLOT_HEIGHT }}
      >
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${DRAW_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible text-primary"
        >
          {graduations.map((value) => (
            <line
              key={value}
              x1={0}
              y1={y(value)}
              x2={DRAW_WIDTH}
              y2={y(value)}
              className="text-border"
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {segments.map((segment) => (
            <g key={segment[0]!.index}>
              <polygon
                points={`${x(segment[0]!.index).toFixed(1)},${base} ${line(segment)} ${x(segment.at(-1)!.index).toFixed(1)},${base}`}
                fill="currentColor"
                opacity="0.1"
              />
              <polyline
                points={line(segment)}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        {/* The dots are HTML: in a stretched drawing a circle would turn into an ellipse. */}
        {last >= 0 && shown === null && <Dot left={percent(last)} top={y(values[last]!)} />}

        {shown !== null && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/25"
              style={{ left: percent(shown) }}
            />
            {shownValue !== null && <Dot left={percent(shown)} top={y(shownValue)} />}
            <span
              aria-live="polite"
              className={cn(
                "pointer-events-none absolute top-0 z-10 grid gap-0.5 rounded-md border bg-popover px-2.5 py-1.5 whitespace-nowrap shadow-float",
                share(shown) < 0.18 ? "translate-x-2" : share(shown) > 0.82 ? "-translate-x-[calc(100%+0.5rem)]" : "-translate-x-1/2",
              )}
              style={{ left: percent(shown) }}
            >
              <span className="text-sm font-medium text-strong">
                {shownValue === null ? "No visit" : `${formatMetric(shownValue, metric)} ${shownValue === 1 ? unit.one : unit.many}`}
              </span>
              <span>{longDay(days[shown]!.day)}</span>
            </span>
          </>
        )}

        <table className="sr-only">
          <caption>{label} per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{label}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day, index) => (
              <tr key={day.day}>
                <th scope="row">{longDay(day.day)}</th>
                <td>{values[index] === null ? "No visit" : formatMetric(values[index]!, metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The dates, under the plot's first, middle and last day. */}
      <div aria-hidden="true" className="relative col-start-2 mt-2 h-4">
        {marks.map((index) => {
          const day = days[index]
          if (day === undefined) return null
          const anchor = index === 0 ? "" : index === days.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
          return (
            <span key={day.day} className={cn("absolute top-0 whitespace-nowrap", anchor)} style={{ left: percent(index) }}>
              {shortDay(day.day)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** A point of the line: 8 px, ringed by the card's colour so that it reads where it crosses the line. */
function Dot({ left, top }: { left: string; top: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
      style={{ left, top }}
    />
  )
}

/**
 * The chart's panel: the four figures in its head, three of them tabs that
 * switch the series below (the Plausible pattern), then the plot. Time on
 * page is a figure and no tab: the snapshot keeps it for the period alone.
 */
function ChartPanel({ measure }: { measure: Measure }) {
  const [metric, setMetric] = useState<Metric>("visits")
  const base = useId()
  const all = figures(measure)
  const tabs = all.filter((figure) => figure.metric !== null)
  const current = tabs.find((figure) => figure.metric === metric) ?? tabs[0]!
  const tabId = (value: Metric) => `${base}-tab-${value}`

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    setMetric(next.metric!)
    document.getElementById(tabId(next.metric!))?.focus()
  }

  return (
    <Panel full>
      {/* Four in a row, or two by two on a narrow panel, where the figure that is no tab takes the last place. */}
      <div className="grid grid-cols-2 border-b @2xl/body:grid-cols-4">
        <div
          role="tablist"
          aria-label="What the chart shows"
          className="col-span-2 col-start-1 row-span-2 row-start-1 grid grid-cols-subgrid grid-rows-subgrid @2xl/body:col-span-3 @2xl/body:row-span-1"
        >
          {tabs.map((figure, index) => {
            const selected = figure.metric === current.metric
            return (
              <button
                key={figure.heading}
                id={tabId(figure.metric!)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${base}-chart`}
                tabIndex={selected ? 0 : -1}
                title={figure.detail}
                onClick={() => setMetric(figure.metric!)}
                onKeyDown={(event) => move(event, index)}
                className={cn(
                  "relative grid content-start gap-1 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  selected ? "text-strong" : "text-foreground hover:bg-muted/45",
                )}
              >
                <span className={cn("mono-label", selected && "text-strong")}>{figure.heading}</span>
                <span className="text-figure tabular-nums">{figure.value}</span>
                {/* The current tab is "here": the accent's 2 px rule along its foot. */}
                <span aria-hidden="true" className={cn("absolute inset-x-0 -bottom-px h-0.5 bg-primary", !selected && "hidden")} />
              </button>
            )
          })}
        </div>
        {all
          .filter((figure) => figure.metric === null)
          .map((figure) => (
            <div
              key={figure.heading}
              title={figure.detail}
              className="col-start-2 row-start-2 grid content-start gap-1 px-4 py-3 @2xl/body:col-start-4 @2xl/body:row-start-1"
            >
              <p className="mono-label">{figure.heading}</p>
              <p className="text-figure tabular-nums">{figure.value}</p>
            </div>
          ))}
      </div>
      <div id={`${base}-chart`} role="tabpanel" aria-labelledby={tabId(current.metric!)} className="px-4 pt-5 pb-4">
        {emptyCurve(measure.days) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing to plot over this period.</p>
        ) : (
          <Curve days={measure.days} metric={current.metric!} label={current.heading} />
        )}
      </div>
    </Panel>
  )
}

// --- The rankings ----------------------------------------------------------------------

/**
 * A ranking's rows, 36 px each: the value, its figure on the right, and the
 * bar drawn as a pale fill behind the row, as long as its share of the
 * first. Behind and not under: one line per row, and the text stays the
 * text's colour whatever the bar's length.
 */
function RankingRows({ ranking, lines }: { ranking: RankingEntry; lines: readonly Row[] }) {
  const first = lines[0]?.total ?? 0
  return (
    <>
      <div aria-hidden="true" className="flex h-8 items-center justify-between gap-4 border-b bg-cell px-4 mono-label">
        <span>{ranking.noun}</span>
        <span>{ranking.unit}</span>
      </div>
      <ol aria-label={`${ranking.title}, by ${ranking.unit}`} className="py-1">
        {lines.map((line) => {
          const label = rankingLabel(ranking.key, line.value)
          return (
            <li key={line.value} className="relative flex h-9 items-center gap-4 px-4">
              <span
                aria-hidden="true"
                className="absolute inset-y-px left-2 rounded-l-sm rounded-r-md bg-primary/10 dark:bg-primary/15"
                style={{ width: `calc((100% - 1rem) * ${rowShare(line, first) / 100})` }}
              />
              <span className={cn("relative min-w-0 flex-1 truncate", ranking.machine && "font-mono text-[0.8125rem]")} title={label}>
                {label}
              </span>
              <span className="relative shrink-0 tabular-nums">
                {formatNumber(line.total)}
                <span className="sr-only"> {ranking.unit}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

/**
 * One of the three panels: its rankings as tabs in its head, the first six
 * rows of the chosen one, and *Show all* for the rest, in a sheet. A tab
 * with no row is not drawn, a panel with none either; a panel left with one
 * ranking says its name without tabs.
 */
function RankingPanel({
  group,
  measure,
  onShowAll,
}: {
  group: RankingGroup
  measure: Measure
  onShowAll: (ranking: RankingEntry) => void
}) {
  const tabs = groupTabs(group, measure.rankings)
  const [chosen, setChosen] = useState<string | null>(null)
  const base = useId()
  if (tabs.length === 0) return null
  const current = tabs.find((ranking) => ranking.id === chosen) ?? tabs[0]!
  const lines = measure.rankings[current.key] ?? []
  const tabId = (ranking: RankingEntry) => `${base}-${ranking.id}`

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    setChosen(next.id)
    document.getElementById(tabId(next))?.focus()
  }

  return (
    <Panel full>
      <div className="flex h-11 items-stretch gap-4 overflow-x-auto border-b px-4 [scrollbar-width:none]">
        {tabs.length === 1 ? (
          <h2 className="flex items-center text-heading">{current.title}</h2>
        ) : (
          <div role="tablist" aria-label={group.title} className="flex items-stretch gap-4">
            {tabs.map((ranking, index) => {
              const selected = ranking.id === current.id
              return (
                <button
                  key={ranking.id}
                  id={tabId(ranking)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${base}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setChosen(ranking.id)}
                  onKeyDown={(event) => move(event, index)}
                  className={cn(
                    "relative shrink-0 rounded-sm text-[0.8125rem] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected ? "font-medium text-strong" : "text-secondary-foreground hover:text-strong",
                  )}
                >
                  {ranking.title}
                  <span
                    aria-hidden="true"
                    className={cn("absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary", !selected && "hidden")}
                  />
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div
        id={`${base}-panel`}
        role={tabs.length === 1 ? undefined : "tabpanel"}
        aria-labelledby={tabs.length === 1 ? undefined : tabId(current)}
      >
        <RankingRows ranking={current} lines={lines.slice(0, TOP_ROWS)} />
        {lines.length > TOP_ROWS && (
          <div className="border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onShowAll(current)}
              className="text-muted-foreground hover:text-foreground max-md:h-9"
            >
              Show all {lines.length}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  )
}

// --- The empty states --------------------------------------------------------------------

/** The site can be measured but has received nobody: the tag to paste, which is the one thing to do. */
function NoVisits({ slug, zone }: { slug: string; zone: string }) {
  return (
    <Panel full>
      <InlineEmpty icon={ChartNoAxesColumn}>No visit recorded for {slug} yet: the tag is probably not on its pages.</InlineEmpty>
      <div className="grid gap-2 px-4 pb-4">
        <Command text={tag(zone)} label="Copy the tag" />
        <p className="text-xs text-muted-foreground">Paste it before &lt;/head&gt; on every page, then deploy the site.</p>
      </div>
    </Panel>
  )
}

/**
 * The header's intro: what is counted and how, then how two of the figures
 * read, which the page used to say above and below its panels.
 */
function Intro({ slug, days, measure }: { slug: string; days: number; measure: Measure | undefined }) {
  return (
    <>
      <p>
        Who reads {slug}
        {days > 0 ? `, over the last ${days} days` : ""}. No cookie, no local storage: a visitor is a fingerprint that the salt of the day
        destroys, so the same reader coming back tomorrow counts twice.
      </p>
      <p className="text-muted-foreground">
        A site is measured once one of its hosts is on the allow list the collector writes, from the manifests and the domain table, within
        a minute of a deployment.
      </p>
      {measure !== undefined && measure.views > 0 && (
        <p className="text-muted-foreground">
          Bounce rate: {measure.bounceRate}% of visits read a single page. Time on page averages only the views whose departure was
          signalled: a browser killed outright sends none.
        </p>
      )}
    </>
  )
}

// --- The section ---------------------------------------------------------------------

function Content({ site, audience, zone }: { site: Site; audience: Audience; zone: string }) {
  const sheet = useSheet("ranking")

  if (!audience.present) {
    return (
      <Panel full>
        <InlineEmpty icon={ChartNoAxesColumn}>
          No audience data yet: the analytics service hasn't left a snapshot, or the collector hasn't copied it.
        </InlineEmpty>
      </Panel>
    )
  }

  const measure: Measure | undefined = audience.sites[site.slug]
  if (measure === undefined) {
    return (
      <Panel full>
        <InlineEmpty icon={ChartNoAxesColumn}>
          {site.headless
            ? `${site.slug} serves no page: there is nothing to measure.`
            : `${site.slug} isn't measured yet: it joins the list within a minute of a deployment.`}
        </InlineEmpty>
      </Panel>
    )
  }

  const stale = audience.stale && (
    <Banner tone="attention">These numbers are {ago(audience.age ?? 0)} old. The analytics service or the collector has stopped.</Banner>
  )
  if (measure.views === 0) {
    return (
      <>
        {stale}
        <NoVisits slug={site.slug} zone={zone} />
      </>
    )
  }

  const open = rankingById(sheet.id)
  const openLines = open === undefined ? [] : (measure.rankings[open.key] ?? [])

  return (
    <>
      {stale}
      <ChartPanel measure={measure} />
      <div className="grid items-start gap-4 @2xl/body:grid-cols-2 @5xl/body:grid-cols-3">
        {RANKING_GROUPS.map((group) => (
          <RankingPanel key={group.id} group={group} measure={measure} onShowAll={(ranking) => sheet.open(ranking.id)} />
        ))}
      </div>
      <DetailSheet
        open={open !== undefined && openLines.length > 0}
        onClose={sheet.close}
        title={open?.title ?? ""}
        description={
          open === undefined ? undefined : `${site.slug}, ${openLines.length} rows by ${open.unit}, over the last ${audience.days} days`
        }
      >
        {open !== undefined && (
          <div className="-mx-4">
            <RankingRows ranking={open} lines={openLines} />
          </div>
        )}
      </DetailSheet>
    </>
  )
}

/**
 * A site's audience, under `/site/audience/?s=<slug>`.
 *
 * The figures come from the `analytics` service, which receives the page views
 * and leaves a snapshot that the collector copies into the reading: this
 * dashboard can neither open its database nor reach it, its unit preventing it.
 * So they travel with the machine's state, in the same call.
 */
export function AudienceSection({ slug }: { slug: string }) {
  const { reading } = useData()
  const audience: Audience =
    reading !== null && reading.present
      ? reading.audience
      : { present: false, age: null, stale: false, days: 0, from: "", to: "", sites: {} }
  const zone = reading !== null && reading.present ? reading.snapshot.zone : ""
  const measure: Measure | undefined = audience.present ? audience.sites[slug] : undefined

  return (
    <SitePage
      slug={slug}
      section="audience"
      intro={<Intro slug={slug} days={audience.days} measure={measure} />}
      skeleton={<PanelSkeleton lines={5} />}
    >
      {(site) => <Content site={site} audience={audience} zone={zone} />}
    </SitePage>
  )
}
