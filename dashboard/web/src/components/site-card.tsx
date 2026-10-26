import { useId, type ReactNode } from "react"
import { AppWindow, CalendarClock, ChevronRight, Cog, type LucideIcon } from "lucide-react"
import { Track } from "@/components/gauge"
import { ExternalLink } from "@/components/link"
import { InternalLink } from "@/components/navigation"
import { useData } from "@/components/data"
import { Banner, Panel, StateLabel, Status } from "@/components/page"
import { CellText, DataTable, gutterFor, type Column } from "@/components/data-table"
import { accessEntry } from "@/components/legend"
import { accessKey } from "@/lib/legend"
import {
  SERVICE_THRESHOLD_POSITIONS,
  SERVICE_THRESHOLDS_TITLE,
  addressSummary,
  serviceCard,
  serviceRows,
  readAccess,
  siteStorage,
  type Fact,
  type Reach,
  type ServiceGauge,
  type ServiceRow,
} from "@/lib/site-card"
import { isAnchoredSite } from "@/lib/sites"
import { TONE_TEXT, severityTone, type Tone } from "@/lib/tones"
import type { Discrepancy, Site } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/**
 * A site's Overview, as a hub: the Service panel, the facts of the service
 * on the machine, one 44 px line each; the Site panel, one line per section
 * with its headline and a chevron to it; the Services table for a project
 * that runs several. A caption that explains a value sits in its tooltip,
 * unless the value is in trouble, when it is said beside it in its tone.
 */

// --- The rows ----------------------------------------------------------------------

/** A facts row: its label in a 6.5 rem column, its value, and for a section, the chevron that leads there. */
const ROW = "grid min-h-11 items-center gap-x-3 px-4 py-2"
const ROW_COLUMNS = "grid-cols-[5.5rem_minmax(0,1fr)] @sm/facts:grid-cols-[6.5rem_minmax(0,1fr)]"
const LINK_COLUMNS = "grid-cols-[5.5rem_minmax(0,1fr)_1rem] @sm/facts:grid-cols-[6.5rem_minmax(0,1fr)_1rem]"
/** A facts list, the container its rows follow: a narrower label column, and a shorter track, in a narrow panel. */
const FACTS = "@container/facts divide-y divide-divider"

/**
 * One line of a facts panel. With `href`, the whole line is the link to the
 * section it sums up, its headline its name, the chevron at its end; a value
 * holding a link of its own (an address) never takes one.
 */
function FactRow({ label, href, tone, children }: { label: string; href?: string; tone?: Tone; children: ReactNode }) {
  const marked = tone === "error" || tone === "attention"
  const content = (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5", marked && cn("font-medium", TONE_TEXT[tone!]))}>{children}</span>
    </>
  )
  if (href === undefined) return <li className={cn(ROW, ROW_COLUMNS)}>{content}</li>
  return (
    <li>
      <InternalLink
        href={href}
        className={cn(
          ROW,
          LINK_COLUMNS,
          "group/fact outline-none hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        {content}
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground group-hover/fact:text-foreground" />
      </InternalLink>
    </li>
  )
}

/** A value whose caption waits in its tooltip, and reaches a screen reader beside it. */
function Explained({ detail, className, children }: { detail: string | null; className?: string; children: ReactNode }) {
  return (
    <span title={detail ?? undefined} className={cn("min-w-0 tabular-nums", className)}>
      {children}
      {detail !== null && <span className="sr-only">, {detail}</span>}
    </span>
  )
}

/** A value still being read: a bar the height of a line of text. */
function ValueSkeleton() {
  return <span aria-hidden="true" className="block h-3.5 w-28 animate-pulse rounded-md bg-muted" />
}

/** The facts whose value is a machine string, set in monospace like every other: a port. */
const MACHINE_FACTS: ReadonlySet<string> = new Set(["Port"])

/** A fact of the card: its caption in the tooltip when all is well, said in its tone beside it when not. */
function FactLine({ fact }: { fact: Fact }) {
  const marked = fact.tone === "attention" || fact.tone === "error"
  const machine = MACHINE_FACTS.has(fact.label) && /^\d+$/.test(fact.value)
  return (
    <FactRow label={fact.label} tone={fact.tone}>
      <Explained detail={marked ? null : fact.detail} className={cn(machine && "font-mono text-[0.8125rem]")}>
        {fact.value}
      </Explained>
      {marked && fact.detail !== null && <span className="text-xs">{fact.detail}</span>}
    </FactRow>
  )
}

// --- The discrepancies -----------------------------------------------------------

/** The site's discrepancies at the top of its Overview, one banner of one line each, errors first. */
export function SiteDiscrepancies({ discrepancies }: { discrepancies: readonly Discrepancy[] }) {
  const id = useId()
  if (discrepancies.length === 0) return null
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h2 id={id} className="sr-only">
        Issues
      </h2>
      {discrepancies.map((discrepancy, index) => {
        const tone = severityTone(discrepancy.severity)
        return (
          <Banner key={index} tone={tone}>
            <span className="sr-only">{tone === "error" ? "Error: " : "Warning: "}</span>
            {discrepancy.message}
          </Banner>
        )
      })}
    </section>
  )
}

// --- The service -----------------------------------------------------------------

/**
 * The service's memory on one line: the amount, a 120 px track ticked at the
 * service's thresholds with its peak marked across it, and the share. The
 * peak's words are in the tooltip: it is what turns the bar amber.
 */
function MemoryLine({ gauge }: { gauge: ServiceGauge }) {
  const { tile } = gauge
  const level = tile.level === "critical" ? "error" : tile.level === "warn" ? "attention" : "neutral"
  return (
    <FactRow label="Memory" tone={level}>
      <Explained detail={gauge.peakDetail}>{gauge.amount}</Explained>
      <span className="relative w-16 shrink-0 @sm/facts:w-[7.5rem]">
        <Track tile={tile} thresholds={SERVICE_THRESHOLD_POSITIONS} title={SERVICE_THRESHOLDS_TITLE} />
        {gauge.peak !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={{ left: `${gauge.peak}%` }}
          />
        )}
      </span>
      {tile.percent !== null && <span className={cn("tabular-nums", level === "neutral" && "text-muted-foreground")}>{tile.percent}%</span>}
    </FactRow>
  )
}

/**
 * The project's main unit, as facts: its state and how long it has been up,
 * its memory against its ceiling, its CPU, its restarts, its port. Nothing
 * for a static site or a folder with no manifest, which run no service: the
 * kind under the title says so. `action` is the Restart a Developer or an
 * Admin may ask for.
 */
export function ServicePanel({ site, now, action }: { site: Site; now: number; action?: ReactNode }) {
  const { snapshot } = useData()
  const card = serviceCard(site, now, snapshot?.machine?.cores ?? null)
  if (card.kind !== "app") return null
  const { state } = card
  const marked = state.tone === "error" || state.tone === "attention"
  // The anchor of a project whose every service is scheduled runs nothing: while it keeps their timers armed, the Services table says it all.
  if (isAnchoredSite(site) && !marked && action === undefined) return null
  const stateDetail = [card.uptime?.since ?? null, card.systemd].filter((piece): piece is string => piece !== null).join(", ")
  return (
    <Panel
      title={card.title}
      full
      actions={
        card.unit === null && action === undefined ? undefined : (
          <>
            {card.unit !== null && <code className="font-mono text-xs text-muted-foreground">{card.unit}</code>}
            {action}
          </>
        )
      }
    >
      <ul className={FACTS}>
        <FactRow label="State" tone={state.tone}>
          <Explained detail={stateDetail === "" ? null : stateDetail}>{state.label}</Explained>
          {card.uptime !== null && <span className="text-muted-foreground tabular-nums">up {card.uptime.value}</span>}
          {/* Why there is no memory to show, or what an anchor does: said when the state is in trouble, on hover otherwise. */}
          {card.note !== null && card.gauge === null && marked && <span className="basis-full text-xs font-normal text-muted-foreground">{card.note}</span>}
        </FactRow>
        {card.gauge !== null && <MemoryLine gauge={card.gauge} />}
        {card.note !== null && card.gauge === null && !marked && (
          <li className="px-4 py-2.5 text-xs text-pretty text-muted-foreground">{card.note}</li>
        )}
        {card.facts.map((fact) => (
          <FactLine key={fact.label} fact={fact} />
        ))}
      </ul>
    </Panel>
  )
}

// --- The services ----------------------------------------------------------------

const SERVICE_ICON: Record<ServiceRow["kind"], LucideIcon> = { server: AppWindow, worker: Cog, scheduled: CalendarClock }
const SERVICE_KIND: Record<ServiceRow["kind"], string> = {
  server: "Serves pages",
  worker: "Background: runs for good, listens on nothing",
  scheduled: "Scheduled: runs at the times its schedule names, nothing between two runs",
}

/** What reaches a service, or what starts it, in words: its paths, the rest of the site, the project alone, its schedule. */
function reachText(reach: Reach): { text: string; mono: boolean; title: string } {
  switch (reach.kind) {
    case "background":
      return { text: "Background", mono: false, title: "A worker: it runs for good, in the background, and listens on nothing" }
    case "scheduled":
      return {
        text: reach.words ?? reach.expression,
        mono: reach.words === null,
        title: `Started by its timer, ${reach.timer}, at the times its schedule names; nothing runs between two runs`,
      }
    case "internal":
      return { text: "Internal", mono: false, title: "Called by the project's other services, never by visitors" }
    case "rest":
      return { text: "All other paths", mono: false, title: "Every request no other service claims" }
    case "paths":
      return { text: reach.paths.join(" "), mono: true, title: `Requests on ${reach.paths.join(", ")}` }
  }
}

function rowSeverity(row: ServiceRow): Severity | null {
  if (row.state.tone === "error" || row.listening === false) return "error"
  if (row.state.tone === "attention" || row.restarts !== null) return "warning"
  return null
}

/**
 * The row's word, quiet when fine: the state when it is not, otherwise what
 * else is wrong, a silent port, restarts. Its tooltip carries the last run
 * of a scheduled service that failed.
 */
function rowState(row: ServiceRow): { tone: Tone; text: string; title?: string } | null {
  if (row.state.tone !== "ok") return { tone: row.state.tone, text: row.state.label, title: row.runs?.last?.text }
  if (row.listening === false) return { tone: "error", text: `Port ${row.port}, nothing listens` }
  if (row.restarts !== null) return { tone: "attention", text: row.restarts }
  return null
}

/** Since when it runs, or when it runs next, without the words the column's head already says. */
function whenText(row: ServiceRow): { text: string; title: string | undefined } | null {
  if (row.runs === null) return null
  const last = row.runs.last?.text
  if (row.state.label === "Running") return last === undefined ? null : { text: last, title: undefined }
  if (row.runs.next === null) return null
  return { text: row.runs.next.replace(/^Next run /, ""), title: last }
}

const SERVICE_COLUMNS: readonly Column<ServiceRow>[] = [
  {
    key: "service",
    head: "Service",
    width: "minmax(12rem,1.4fr)",
    slot: "primary",
    cell: (row) => {
      const Icon = SERVICE_ICON[row.kind]
      const state = rowState(row)
      return (
        <>
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only">{SERVICE_KIND[row.kind]}: </span>
          <span title={row.unit} className="shrink-0 font-medium text-strong">
            {row.name}
          </span>
          {state !== null && (
            <StateLabel tone={state.tone} title={state.title}>
              {state.text}
            </StateLabel>
          )}
          {/* On two lines the unit goes: the name and the state fill the first, and the unit stays in the name's tooltip. */}
          <CellText title={row.unit} className="font-mono text-xs text-muted-foreground @max-2xl/table:hidden">
            {row.unit}
          </CellText>
        </>
      )
    },
  },
  {
    key: "reach",
    head: "How it runs",
    width: "minmax(8rem,1fr)",
    cell: (row) => {
      const reach = reachText(row.reach)
      const port = row.port === null ? "" : `, port ${row.port}`
      return (
        <CellText title={`${reach.title}${port}`} className={cn("text-muted-foreground", reach.mono && "font-mono text-[0.8125rem]")}>
          {reach.text}
        </CellText>
      )
    },
  },
  {
    key: "memory",
    head: "Memory",
    // Room for the longest, "900 MB of 3.8 GB", on one line.
    width: "9rem",
    align: "end",
    // On two lines an empty cell goes, its dot with it; in columns it keeps its track.
    className: "@max-2xl/table:empty:hidden",
    // Nothing while it does not run: a scheduled service between two runs weighs nothing, and a stopped one says so in its state.
    cell: (row) => row.memory,
  },
  {
    key: "when",
    head: "Next run",
    width: "7.5rem",
    align: "end",
    slot: "time",
    cell: (row) => {
      const when = whenText(row)
      return when === null ? null : (
        <span title={when.title} className="text-muted-foreground">
          {when.text}
        </span>
      )
    },
  },
]

/**
 * The processes of a project that runs several, one line each: its kind's
 * icon, its name and unit, its state only when not fine, what reaches it or
 * its schedule, what it weighs, its next run. Nothing for a single service,
 * which the Service panel already describes whole, unless it is scheduled:
 * the Service panel then describes the project's anchor.
 */
export function ServicesPanel({ site, now }: { site: Site; now: number }) {
  const rows = serviceRows(site, now)
  if (rows.length === 0) return null
  const scheduled = rows.some((row) => row.runs !== null)
  return (
    <Panel title="Services" count={rows.length} full>
      <DataTable
        label={`Services of ${site.slug}`}
        caption="The main one first."
        rows={rows}
        rowKey={(row) => row.unit}
        columns={scheduled ? SERVICE_COLUMNS : SERVICE_COLUMNS.filter((column) => column.key !== "when")}
        severity={gutterFor(rows, rowSeverity)}
        narrowBelow="42rem"
      />
    </Panel>
  )
}

// --- The Site panel --------------------------------------------------------------

/** What the Site panel shows of a section: its headline once read, a bar the height of a line until then. */
export type Headline = { state: "loading" } | { state: "ready"; content: ReactNode }

function Head({ headline }: { headline: Headline }) {
  return headline.state === "loading" ? <ValueSkeleton /> : <>{headline.content}</>
}

/**
 * Where the site answers: the address that does, a link; a domain not yet
 * answering as asked, its state in a word; the other addresses under it,
 * muted. A project that serves no page says so rather than offer itself as
 * a page.
 */
function AddressLine({ site }: { site: Site }) {
  const address = addressSummary(site)
  return (
    <FactRow label="Address">
      <ExternalLink href={address.href} className="font-mono text-[0.8125rem] text-foreground">
        {address.name}
      </ExternalLink>
      {address.domain !== null && (
        <StateLabel tone={address.domain.state.tone} className="text-xs">
          {`${address.domain.state.label}: ${address.domain.name}`}
        </StateLabel>
      )}
      {address.headless && <span className="text-xs text-muted-foreground">Serves no page</span>}
      {address.others.length > 0 && (
        <span className="basis-full truncate font-mono text-xs text-muted-foreground" title={address.others.join(", ")}>
          {address.others.join(", ")}
        </span>
      )}
    </FactRow>
  )
}

/**
 * How the site opens, with the Access section's icon and word, and who is on
 * its list. A disagreement between sitesolide.json and the server is an
 * error: the row says it in red, and under it each setting from both sides.
 */
function AccessLine({ site, href, people, plain }: { site: Site; href: string; people: string | null; plain: boolean }) {
  const reading = readAccess(site, plain)
  const key = accessKey(reading.access)
  const { icon: Icon, tone } = accessEntry(key)
  const error = reading.tone === "error"
  return (
    <>
      <FactRow label="Access" href={href} tone={error ? "error" : undefined}>
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
        <span className="min-w-0">
          {error && <span className="sr-only">Error: </span>}
          {reading.title}
        </span>
        {people !== null && !error && <span className="text-muted-foreground">{people}</span>}
      </FactRow>
      {error && reading.checks.length > 0 && (
        <li className="bg-cell/60">
          <table className="w-full text-sm">
            <caption className="sr-only">Each setting, as sitesolide.json asks and as the server applies it</caption>
            <thead className="mono-label">
              <tr>
                <th scope="col" className="h-8 py-0 pr-3 pl-4 text-left">
                  Setting
                </th>
                <th scope="col" className="h-8 px-3 py-0 text-left tracking-normal normal-case">
                  sitesolide.json
                </th>
                <th scope="col" className="h-8 py-0 pr-4 pl-3 text-left">
                  Server
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider border-t border-divider">
              {reading.checks.map((check) => (
                <tr key={check.setting}>
                  <th scope="row" className="py-2 pr-3 pl-4 text-left align-top font-normal">
                    {check.setting}
                  </th>
                  <td className="px-3 py-2 align-top">{check.requested}</td>
                  <td className="py-2 pr-4 pl-3 align-top">
                    {check.tone === "error" ? (
                      <Status tone="error" className="whitespace-normal">
                        {check.applied}
                      </Status>
                    ) : (
                      check.applied
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      )}
    </>
  )
}

/**
 * The site's hub: one line per section, its headline and a chevron to it,
 * between where it answers and what it weighs. Each section's line shows for
 * whoever may open that section; `null` leaves it out.
 */
export function SitePanel({
  site,
  now,
  links,
  people,
  plainAccess,
  secrets,
  backups,
  audience,
  deployedBy = null,
}: {
  site: Site
  now: number
  /** The address of each section the reader may open. */
  links: { access: string; secrets: string | null; backups: string | null; audience: string | null }
  /** Who is on the list, in a few words, once read. */
  people: string | null
  /** A Viewer or a Developer reads Applied rather than the Caddy block. */
  plainAccess: boolean
  secrets: Headline | null
  backups: Headline | null
  audience: Headline | null
  /** Who made the last deployment, when Activity knows it. */
  deployedBy?: string | null
}) {
  return (
    <Panel title="Site" full>
      <ul className={FACTS}>
        <AddressLine site={site} />
        <AccessLine site={site} href={links.access} people={people} plain={plainAccess} />
        {secrets !== null && links.secrets !== null && (
          <FactRow label="Secrets" href={links.secrets}>
            <Head headline={secrets} />
          </FactRow>
        )}
        {backups !== null && links.backups !== null && (
          <FactRow label="Backups" href={links.backups}>
            <Head headline={backups} />
          </FactRow>
        )}
        {audience !== null && links.audience !== null && (
          <FactRow label="Audience" href={links.audience}>
            <Head headline={audience} />
          </FactRow>
        )}
        {siteStorage(site, now).map((fact) =>
          fact.label === "Deployed" && deployedBy !== null ? (
            <FactRow key={fact.label} label={fact.label}>
              <Explained detail={fact.detail}>{fact.value}</Explained>
              <span className="min-w-0 truncate text-muted-foreground">by {deployedBy}</span>
            </FactRow>
          ) : (
            <FactLine key={fact.label} fact={fact} />
          ),
        )}
      </ul>
    </Panel>
  )
}
