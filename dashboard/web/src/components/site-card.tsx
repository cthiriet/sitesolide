import { useId, type ReactNode } from "react"
import { FileCode2, KeyRound, ShieldCheck, ShieldOff, ShieldX, type LucideIcon } from "lucide-react"
import { Track } from "@/components/gauge"
import { ExternalLink } from "@/components/link"
import { Banner, Panel, Status } from "@/components/page"
import { CodeChip } from "@/components/site-access"
import { type Level } from "@/lib/gauges"
import {
  SERVICE_THRESHOLD_POSITIONS,
  SERVICE_THRESHOLDS_TITLE,
  siteAddresses,
  siteFolder,
  serviceCard,
  readAccess,
  siteStorage,
  type Fact,
  type ServiceGauge,
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
    <dl className={cn("divide-y", className)}>
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
              "font-display text-[1.75rem] leading-8 font-semibold tracking-tight tabular-nums",
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
        <Track tile={tile} thresholds={SERVICE_THRESHOLD_POSITIONS} title={SERVICE_THRESHOLDS_TITLE} notch="bg-card" />
        {gauge.peak !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
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

export function ServicePanel({ site, now }: { site: Site; now: number }) {
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
    <Panel title="Service" full actions={card.unit === null ? undefined : <Terminal>{card.unit}</Terminal>}>
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

// --- The addresses ---------------------------------------------------------------

export function AddressesPanel({ site }: { site: Site }) {
  const lines = siteAddresses(site)
  return (
    <Panel title="Addresses" full>
      <ul className="divide-y">
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

// --- The door --------------------------------------------------------------------

const ACCESS_ICONS: Record<"code" | "portal" | "open" | "mismatch", LucideIcon> = {
  code: KeyRound,
  portal: ShieldCheck,
  open: ShieldOff,
  mismatch: ShieldX,
}

/** The site's door as the snapshot sees it, on its Overview; `actions` leads to its Access section. */
export function AccessPanel({ site, actions }: { site: Site; actions?: ReactNode }) {
  const reading = readAccess(site)
  const { access } = reading
  const Icon = ACCESS_ICONS[access.kind]
  const error = reading.tone === "error"
  return (
    <Panel title="Access" full actions={actions}>
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
              {access.exemptions.length === 0 ? "No public paths: every request goes through the portal." : "Public paths, guarded by the site alone"}
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
          <caption className="sr-only">Each gate, as sitesolide.json asks and as the server applies it</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="h-8 py-0 pr-3 pl-4 text-left font-medium">
                Gate
              </th>
              <th scope="col" className="h-8 px-3 py-0 text-left font-medium">
                sitesolide.json
              </th>
              <th scope="col" className="h-8 py-0 pr-4 pl-3 text-left font-medium">
                Server
              </th>
            </tr>
          </thead>
          <tbody className="divide-y border-t">
            {reading.checks.map((check) => (
              <tr key={check.door}>
                <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
                  {check.door}
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
