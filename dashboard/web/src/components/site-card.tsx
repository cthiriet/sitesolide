import { useId, type ReactNode } from "react"
import { FileCode2, Globe, KeyRound, Lock, ShieldCheck, ShieldOff, ShieldX, type LucideIcon } from "lucide-react"
import { Track } from "@/components/gauge"
import { ExternalLink } from "@/components/link"
import { Banner, Panel, Status } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ABSENT } from "@/lib/format"
import { BAR_CLASSES } from "@/lib/gauges"
import { CodeChip } from "@/components/access-word"
import { type Level } from "@/lib/gauges"
import {
  SERVICE_THRESHOLD_POSITIONS,
  SERVICE_THRESHOLDS_TITLE,
  siteAddresses,
  siteFolder,
  serviceCard,
  serviceRows,
  readAccess,
  siteStorage,
  type Fact,
  type Reach,
  type ServiceGauge,
  type ServiceRow,
} from "@/lib/site-card"
import { TONE_TEXT, severityTone } from "@/lib/tones"
import type { Discrepancy, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The figure takes its bar's colour beyond the first threshold, as on the machine plate. */
const LEVEL_TEXT: Record<Level, string> = {
  normal: "",
  warn: "text-attention-text",
  critical: "text-destructive",
}

/** A path or a unit name, what gets typed into a terminal: monospace, discreet. */
function Terminal({ children }: { children: string }) {
  return <code className="font-mono text-xs text-muted-foreground">{children}</code>
}

/** Facts as divided rows: the label on the left, the value and its clarification on the right. */
function FactList({ facts, className }: { facts: readonly Fact[]; className?: string }) {
  if (facts.length === 0) return null
  return (
    <dl className={cn("divide-y divide-divider", className)}>
      {facts.map((fact) => {
        const marked = fact.tone === "attention" || fact.tone === "error"
        return (
          <div key={fact.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn("tabular-nums", marked && cn("font-medium", TONE_TEXT[fact.tone]))}>{fact.value}</span>
              {fact.detail !== null && (
                <span className={cn("text-xs", marked ? TONE_TEXT[fact.tone] : "text-muted-foreground")}>{fact.detail}</span>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

// --- The discrepancies -----------------------------------------------------------

/** The site's discrepancies at the top of its card, one banner each, errors first. */
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
 * The service's memory, in the manner of the machine plate: the figure, the
 * track and its ticks, here at the service's thresholds. The peak is a marker
 * on the track, repeated in the caption: it is what turns the bar amber.
 */
function MemoryGauge({ gauge }: { gauge: ServiceGauge }) {
  const { tile } = gauge
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              "text-2xl leading-7 font-semibold tracking-title tabular-nums",
              LEVEL_TEXT[tile.level],
            )}
          >
            {tile.value}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">{tile.detail}</span>
        </p>
        {tile.percent !== null && (
          <span className="text-sm text-muted-foreground tabular-nums">{tile.percent}%</span>
        )}
      </div>
      <div className="relative">
        <Track tile={tile} thresholds={SERVICE_THRESHOLD_POSITIONS} title={SERVICE_THRESHOLDS_TITLE} />
        {gauge.peak !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={{ left: `${gauge.peak}%` }}
          />
        )}
      </div>
      <p className="-mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {gauge.peak !== null && <span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-foreground" />}
        {gauge.peakDetail}
      </p>
    </div>
  )
}

export function ServicePanel({ site, now, action }: { site: Site; now: number; action?: ReactNode }) {
  const card = serviceCard(site, now)
  if (card.kind !== "app") {
    return (
      <Panel title="Service">
        <div className="flex gap-3">
          <FileCode2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="grid gap-1">
            <p className="font-medium">{card.kind === "static" ? "Static files" : "No manifest"}</p>
            <p className="text-muted-foreground">
              {card.kind === "static"
                ? "Caddy serves the folder as files. There is no service to run or watch."
                : "The folder has no sitesolide.json and no service: Caddy serves it as it is."}
            </p>
          </div>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title={site.services.length > 1 ? "Main service" : "Service"}
      full
      actions={
        card.unit === null && action === undefined ? undefined : (
          <>
            {card.unit !== null && <Terminal>{card.unit}</Terminal>}
            {action}
          </>
        )
      }
    >
      <div className="grid gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Status tone={card.state.tone} className="font-medium">
            {card.state.label}
          </Status>
          {card.systemd !== null && <span className="text-xs text-muted-foreground">{card.systemd}</span>}
        </div>
        {card.gauge !== null ? (
          <MemoryGauge gauge={card.gauge} />
        ) : card.unit === null ? (
          <p className="text-muted-foreground">No systemd unit is loaded for this app: nothing answers behind Caddy.</p>
        ) : (
          <p className="text-muted-foreground">The service isn't running, so it has no memory in use.</p>
        )}
      </div>
      <FactList facts={card.facts} className="border-t" />
    </Panel>
  )
}

/** What reaches a service, as a badge: its paths, the rest of the site, or the project alone. */
function ReachBadges({ reach }: { reach: Reach }) {
  if (reach.kind === "internal") {
    return (
      <Badge variant="secondary" className="rounded-md" title="Called by the project's other services, never by visitors">
        <Lock aria-hidden="true" />
        Internal
      </Badge>
    )
  }
  if (reach.kind === "rest") {
    return (
      <Badge variant="outline" className="rounded-md" title="Every request no other service claims">
        <Globe aria-hidden="true" />
        All other paths
      </Badge>
    )
  }
  return (
    <span className="flex flex-wrap gap-1">
      {reach.paths.map((path) => (
        <Badge key={path} variant="outline" className="rounded-md font-mono" title="Requests on this path">
          <Globe aria-hidden="true" />
          {path}
        </Badge>
      ))}
    </span>
  )
}

/** The port under the badge: where Caddy, or the siblings, reach the service. */
function PortLine({ row }: { row: ServiceRow }) {
  if (row.port === null) return null
  return row.listening === false ? (
    <span className="text-xs font-medium text-destructive tabular-nums">port {row.port}, nothing listens</span>
  ) : (
    <span className="text-xs text-muted-foreground tabular-nums">port {row.port}</span>
  )
}

/** Memory against the ceiling, a short bar and the figure; a dash when the service isn't running. */
function MemoryLine({ row }: { row: ServiceRow }) {
  if (row.memory === null) return <span className="text-muted-foreground">{ABSENT}</span>
  return (
    <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
      {row.memoryPercent !== null && (
        <Progress
          value={row.memoryPercent}
          aria-hidden="true"
          className={cn("w-12 shrink-0 [&_[data-slot=progress-track]]:h-1", BAR_CLASSES[row.memoryLevel])}
        />
      )}
      {row.memory}
    </span>
  )
}

function StateLine({ row, className }: { row: ServiceRow; className?: string }) {
  return (
    <span className={cn("grid justify-items-start gap-0.5", className)}>
      <Status tone={row.state.tone} className={row.state.tone === "ok" ? undefined : "font-medium"}>
        {row.state.label}
      </Status>
      {row.restarts !== null && <span className="text-xs text-attention-text tabular-nums">{row.restarts}</span>}
    </span>
  )
}

const SERVICES_HEAD = "h-10 px-3 text-xs font-medium text-muted-foreground"
const SERVICES_CELL = "px-3 py-3 align-top whitespace-normal"

/**
 * The processes of a project that runs several: what each one is, what
 * reaches it, what it weighs and how it runs. A table where there is room, a
 * card per service below that. Nothing for a single service, which the
 * Service panel already describes whole.
 */
export function ServicesPanel({ site }: { site: Site }) {
  const rows = serviceRows(site)
  if (rows.length === 0) return null
  return (
    <Panel
      title="Services"
      count={rows.length}
      full
      description="Caddy sends each request to the service that claims its path. An internal service is only called by the others."
    >
      <div className="@container">
        <div className="hidden @xl:block">
          <Table>
            <caption className="sr-only">The services of {site.slug}, the main one first.</caption>
            <TableHeader className="bg-muted">
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn(SERVICES_HEAD, "pl-4")}>Service</TableHead>
                <TableHead className={SERVICES_HEAD}>Receives</TableHead>
                <TableHead className={SERVICES_HEAD}>Memory</TableHead>
                <TableHead className={cn(SERVICES_HEAD, "pr-4")}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.unit} className="border-divider hover:bg-transparent">
                  <TableCell className={cn(SERVICES_CELL, "pl-4")}>
                    <span className="grid gap-0.5">
                      <span className="font-medium">{row.name}</span>
                      <Terminal>{row.unit}</Terminal>
                    </span>
                  </TableCell>
                  <TableCell className={SERVICES_CELL}>
                    <span className="grid justify-items-start gap-1">
                      <ReachBadges reach={row.reach} />
                      <PortLine row={row} />
                    </span>
                  </TableCell>
                  <TableCell className={SERVICES_CELL}>
                    <MemoryLine row={row} />
                  </TableCell>
                  <TableCell className={cn(SERVICES_CELL, "pr-4")}>
                    <StateLine row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="divide-y divide-divider @xl:hidden">
          {rows.map((row) => (
            <li key={row.unit} className="grid gap-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <span className="grid gap-0.5">
                  <span className="font-medium">{row.name}</span>
                  <Terminal>{row.unit}</Terminal>
                </span>
                <StateLine row={row} className="justify-items-end" />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <ReachBadges reach={row.reach} />
                <PortLine row={row} />
                <span className="ml-auto text-xs">
                  <MemoryLine row={row} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

// --- The addresses ---------------------------------------------------------------

export function AddressesPanel({ site }: { site: Site }) {
  const lines = siteAddresses(site)
  return (
    <Panel title="Addresses" full>
      <ul className="divide-y divide-divider">
        {lines.map((line) => (
          <li
            key={line.name}
            className={cn("flex items-start justify-between gap-3 py-2.5 pr-4", line.role === "alias" ? "pl-8" : "pl-4")}
          >
            <div className="grid min-w-0 justify-items-start gap-0.5">
              {line.href === null ? (
                <span className="wrap-anywhere" title="Doesn't answer yet">
                  {line.name}
                </span>
              ) : (
                <ExternalLink href={line.href}>{line.name}</ExternalLink>
              )}
              {line.detail !== null && <span className="text-xs text-muted-foreground">{line.detail}</span>}
            </div>
            {line.state !== null && (
              <Status tone={line.state.tone} className="mt-px">
                {line.state.label}
              </Status>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// --- General access ------------------------------------------------------------------

const ACCESS_ICONS: Record<"code" | "portal" | "open" | "mismatch", LucideIcon> = {
  code: KeyRound,
  portal: ShieldCheck,
  open: ShieldOff,
  mismatch: ShieldX,
}

/** The site's general access as the snapshot sees it, on its Overview; `actions` leads to its Access section. */
export function AccessPanel({ site, actions }: { site: Site; actions?: ReactNode }) {
  const reading = readAccess(site)
  const { access } = reading
  const Icon = ACCESS_ICONS[access.kind]
  const error = reading.tone === "error"
  return (
    <Panel title="General access" full actions={actions}>
      <div className="grid gap-3 p-4">
        <div className="flex gap-3">
          <Icon
            aria-hidden="true"
            className={cn("mt-0.5 size-4 shrink-0", error ? "text-destructive" : "text-muted-foreground")}
          />
          <div className="grid min-w-0 gap-1">
            <p className={cn("font-medium", error && "text-destructive")}>
              {error && <span className="sr-only">Error: </span>}
              {reading.title}
            </p>
            <p className="text-muted-foreground">{reading.detail}</p>
          </div>
        </div>

        {access.kind === "code" && (
          <div className="pl-7">
            <CodeChip slug={site.slug} code={access.code} url={access.url} large />
          </div>
        )}

        {access.kind === "portal" && (
          <div className="grid gap-1.5 pl-7">
            <p className="text-xs text-muted-foreground">
              {access.exemptions.length === 0 ? "Every path asks to sign in." : "Open to anyone, guarded by the app alone:"}
            </p>
            {access.exemptions.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {access.exemptions.map((path) => (
                  <li key={path}>
                    <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {reading.checks.length > 0 && (
        <table className="w-full border-t text-sm">
          <caption className="sr-only">Each setting, as sitesolide.json asks and as the server applies it</caption>
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="h-8 py-0 pr-3 pl-4 text-left font-medium">
                Setting
              </th>
              <th scope="col" className="h-8 px-3 py-0 text-left font-medium">
                sitesolide.json
              </th>
              <th scope="col" className="h-8 py-0 pr-4 pl-3 text-left font-medium">
                Server
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider border-t">
            {reading.checks.map((check) => (
              <tr key={check.setting}>
                <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
                  {check.setting}
                </th>
                <td className="px-3 py-2.5 align-top">{check.requested}</td>
                <td className="py-2.5 pr-4 pl-3 align-top">
                  <Status tone={check.tone} className="whitespace-normal">
                    {check.applied}
                  </Status>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

// --- The storage -----------------------------------------------------------------

export function StoragePanel({ site, now }: { site: Site; now: number }) {
  return (
    <Panel title="Storage" full actions={<Terminal>{siteFolder(site.slug)}</Terminal>}>
      <FactList facts={siteStorage(site, now)} />
    </Panel>
  )
}
