import { ChartNoAxesColumn } from "lucide-react"
import { useId } from "react"
import { useData } from "@/components/data"
import { Banner, EmptyState, Panel, PanelSkeleton } from "@/components/page"
import { SitePage } from "@/components/site"
import {
  figures,
  RANKINGS,
  emptyCurve,
  shortDay,
  rankingLabel,
  formatNumber,
  rowShare,
  axisCeiling,
} from "@/lib/audience"
import { ago } from "@/lib/format"
import type { Audience, DayCount, Measure, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

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

/**
 * The visits curve, in hand-written SVG.
 *
 * **One single series, and that is a choice.** Views and visits read on the
 * same scale, but two lines would call for two distinct hues, which this
 * dashboard's ramp does not have: it is sequential, one single hue from light
 * to dark, and two of its steps would blur together in one of the two themes.
 * The series drawn is the one that decides, the visits; the views are in the
 * banner above, and in each day's tooltip.
 *
 * No library: two hundred bytes of path beat one more dependency in a bundle
 * the VM only receives as HTML and JS.
 */
function Curve({ days }: { days: readonly DayCount[] }) {
  const titleId = useId()
  const width = 720
  const height = 180
  const margin = { top: 12, right: 12, bottom: 22, left: 38 }
  const plot = {
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  }

  const ceiling = axisCeiling(Math.max(...days.map((day) => day.visits), 0))
  const x = (index: number) =>
    days.length <= 1
      ? margin.left + plot.width / 2
      : margin.left + (index / (days.length - 1)) * plot.width
  const y = (value: number) => margin.top + plot.height - (value / ceiling) * plot.height

  const points = days.map((day, index) => `${x(index).toFixed(1)},${y(day.visits).toFixed(1)}`)
  const area = `${margin.left},${(margin.top + plot.height).toFixed(1)} ${points.join(" ")} ${(
    margin.left + plot.width
  ).toFixed(1)},${(margin.top + plot.height).toFixed(1)}`

  // Three ticks: the grid is a reference, not a mesh.
  const graduations = [0, ceiling / 2, ceiling]
  // First, middle, last: thirty dates would not fit without overlapping, and
  // three are enough to place the window.
  const marks = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
  const step = days.length > 1 ? plot.width / (days.length - 1) : plot.width

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full text-primary"
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>Visits per day over the period</title>

      {graduations.map((value) => (
        <g key={value} className="text-border">
          <line
            x1={margin.left}
            y1={y(value)}
            x2={margin.left + plot.width}
            y2={y(value)}
            stroke="currentColor"
            strokeWidth="1"
          />
          <text
            x={margin.left - 8}
            y={y(value)}
            dy="0.32em"
            textAnchor="end"
            fontSize="11"
            className="fill-muted-foreground"
          >
            {formatNumber(Math.round(value))}
          </text>
        </g>
      ))}

      {marks.map((index) => {
        const day = days[index]
        if (day === undefined) return null
        return (
          <text
            key={day.day}
            x={x(index)}
            y={height - 5}
            textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
            fontSize="11"
            className="fill-muted-foreground"
          >
            {shortDay(day.day)}
          </text>
        )
      })}

      <polygon points={area} fill="currentColor" opacity="0.1" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(days.length - 1)} cy={y(days[days.length - 1]?.visits ?? 0)} r="4" fill="currentColor" />

      {/* One invisible band per day, carrying the browser's tooltip: that is
          all a hover needs when the page has no charting script, and it works
          too where hovering does not exist. */}
      {days.map((day, index) => (
        <rect
          key={day.day}
          x={Math.max(margin.left, x(index) - step / 2)}
          y={margin.top}
          width={step}
          height={plot.height}
          fill="transparent"
        >
          <title>{`${shortDay(day.day)}: ${formatNumber(day.visits)} visits, ${formatNumber(day.views)} views`}</title>
        </rect>
      ))}
    </svg>
  )
}

/** One of the banner's figures: the label, the value, what it counts. */
function Figure({ heading, value, detail }: { heading: string; value: string; detail: string }) {
  return (
    <div className="grid content-start gap-1 rounded-lg border bg-card px-4 py-3">
      <p className="text-sm text-muted-foreground">{heading}</p>
      <p className="font-display text-[1.75rem] leading-8 font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

/**
 * A ranking: the label, its value, and the bar underneath.
 *
 * The bar sits under the text rather than behind it: a long path would
 * otherwise go from readable to unreadable in the middle of a word, depending
 * on whether it runs past the colour.
 */
function Ranking({ key, title, unit, lines }: { key: string; title: string; unit: string; lines: readonly { value: string; total: number }[] }) {
  const first = lines[0]?.total ?? 0
  return (
    <Panel title={title} actions={<span className="text-xs text-muted-foreground uppercase">{unit}</span>} full>
      <ul className="divide-y">
        {lines.map((line) => (
          <li key={line.value} className="px-4 py-2">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="truncate" title={line.value}>
                {rankingLabel(key, line.value)}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(line.total)}</span>
            </div>
            <div
              className="mt-1.5 h-1.5 rounded-r-[4px] bg-primary/70"
              style={{ width: `${rowShare(line, first)}%` }}
            />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** What is displayed when the measurement service has left nothing. */
function NoSnapshot() {
  return (
    <Panel>
      <EmptyState icon={ChartNoAxesColumn} title="No audience data yet">
        The analytics service hasn't written a snapshot, or the collector hasn't picked it up. It lands in the same
        relay as the machine state, once a minute.
      </EmptyState>
    </Panel>
  )
}

/** What is displayed when the site can be measured but has received nobody. */
function NoVisits({ slug, zone }: { slug: string; zone: string }) {
  return (
    <Panel>
      <EmptyState icon={ChartNoAxesColumn} title={`No visit recorded for ${slug}`}>
        <span className="grid gap-3">
          <span>
            The host is on the allow list, so the service would accept its views. Nothing has arrived: the tag is
            probably not on the pages yet.
          </span>
          <code className="block overflow-x-auto rounded-md bg-foreground/5 px-3 py-2 text-left font-mono text-xs">
            {tag(zone)}
          </code>
          <span>Paste it before &lt;/head&gt; on every page, then deploy the site.</span>
        </span>
      </EmptyState>
    </Panel>
  )
}

function Content({ site, audience, zone }: { site: Site; audience: Audience; zone: string }) {
  if (!audience.present) return <NoSnapshot />

  const measure: Measure | undefined = audience.sites[site.slug]
  if (measure === undefined) {
    return (
      <Panel>
        <EmptyState icon={ChartNoAxesColumn} title={`${site.slug} isn't measured`}>
          No hostname of this folder is on the allow list the collector writes. That list comes from the manifests and
          from the domain table, so a deployed site lands on it within the minute.
        </EmptyState>
      </Panel>
    )
  }

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        Who reads {site.slug}, over the last {audience.days} days. No cookie, no local storage: a visitor is a
        fingerprint that the salt of the day destroys, so the same reader coming back tomorrow counts twice.
      </p>

      {audience.stale && (
        <Banner tone="attention">
          These numbers are {ago(audience.age ?? 0)} old. The analytics service or the collector has stopped.
        </Banner>
      )}

      <div className="grid gap-3 @lg/body:grid-cols-2 @4xl/body:grid-cols-4">
        {figures(measure).map((figure) => (
          <Figure key={figure.heading} {...figure} />
        ))}
      </div>

      <Panel title="Visits" description={`${audience.from} to ${audience.to}`}>
        {emptyCurve(measure.days) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing to plot over this period.</p>
        ) : (
          <Curve days={measure.days} />
        )}
      </Panel>

      {measure.views === 0 ? (
        <NoVisits slug={site.slug} zone={zone} />
      ) : (
        <div className={cn("grid items-start gap-4", "@4xl/body:grid-cols-2")}>
          {RANKINGS.map(({ key, title, unit }) => {
            const lines = measure.rankings[key] ?? []
            if (lines.length === 0) return null
            return <Ranking key={key} key={key} title={title} unit={unit} lines={lines} />
          })}
        </div>
      )}

      <p className="max-w-2xl text-xs leading-relaxed text-pretty text-muted-foreground">
        Bounce rate {measure.bounceRate}% of visits read a single page. Time on page averages only the views whose departure
        was signalled: a browser killed outright sends none.
      </p>
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

  return (
    <SitePage slug={slug} section="audience" skeleton={<PanelSkeleton lines={5} />}>
      {(site) => <Content site={site} audience={audience} zone={zone} />}
    </SitePage>
  )
}
