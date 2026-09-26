import { useMemo, type MouseEvent } from "react"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ExternalLink } from "@/components/link"
import { InternalLink, useNavigation } from "@/components/navigation"
import { SeverityIcon, Panel, Status } from "@/components/page"
import { Gate } from "@/components/site-access"
import { ago, size } from "@/lib/format"
import { BAR_CLASSES } from "@/lib/gauges"
import { siteUrl } from "@/lib/pages"
import { PENDING_LABEL, type SiteSecretsPanel } from "@/lib/secrets"
import {
  INTERACTIVE,
  siteAccess,
  siteAddress,
  serviceState,
  rowClickOutcome,
  serviceSummaryOf,
  type Address,
  type ServiceSummary,
} from "@/lib/sites"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/** A site, with what the secrets say of it once read: the names of its variables, a restart pending. */
export type SiteWithSecrets = Site & Partial<SiteSecretsPanel>

/**
 * The click on a row, outside its links and buttons: the site's Overview, in
 * the page or in a new tab. See `rowClickOutcome` for what decides.
 */
function useRowClick(href: string) {
  const { navigate } = useNavigation()
  return useMemo(() => {
    function follow(event: MouseEvent<HTMLElement>) {
      const target = event.target instanceof Element ? event.target : null
      const interactive = target !== null && target.closest(INTERACTIVE) !== null
      const selection = window.getSelection()?.toString() ?? ""
      const outcome = rowClickOutcome(event, interactive, selection)
      if (outcome === "page") navigate(href)
      else if (outcome === "tab") window.open(href, "_blank", "noopener")
    }
    return { onClick: follow, onAuxClick: follow }
  }, [href, navigate])
}

/** A site's name: the real link to it, the one for the keyboard and for screen readers. */
function SiteName({ slug }: { slug: string }) {
  return (
    <InternalLink
      href={siteUrl(slug)}
      className="rounded-sm font-medium wrap-anywhere underline decoration-foreground/20 underline-offset-4 outline-none group-hover/ligne:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {slug}
    </InternalLink>
  )
}

/** A secret changed since the last startup: the service is still running with the old value. */
function PendingPill() {
  return (
    <Status tone="attention" shape="pill" title="A secret changed after the service last started" className="h-5 px-1.5">
      {PENDING_LABEL}
    </Status>
  )
}

/** The severity icon has its own reserved place, so the names stay aligned from one row to the next. */
function Gutter({ severity }: { severity: Severity | null }) {
  return (
    <span className="flex h-5 w-4 shrink-0 items-center">
      {severity !== null && <SeverityIcon severity={severity} label />}
    </span>
  )
}

function AddressCell({ address }: { address: Address }) {
  return (
    <div className="grid justify-items-start gap-0.5">
      <ExternalLink href={address.href}>{address.text}</ExternalLink>
      {address.note !== null && (
        <span
          className={cn("text-xs wrap-anywhere", address.note.warn ? "text-attention-text" : "text-muted-foreground")}
        >
          {address.note.text}
        </span>
      )}
    </div>
  )
}

/** Memory over its ceiling, as a short bar: neutral, then in the colours of the service's thresholds. */
function MemoryBar({ summary, className }: { summary: Extract<ServiceSummary, { kind: "active" }>; className?: string }) {
  if (summary.percent === null) return null
  return (
    <Progress
      value={summary.percent}
      aria-hidden="true"
      className={cn("w-12 shrink-0 [&_[data-slot=progress-track]]:h-1", BAR_CLASSES[summary.level], className)}
    />
  )
}

/** The service's word; neutral, it fades back, a static site having nothing to watch. */
function ServiceWord({ site, className }: { site: Site; className?: string }) {
  const state = serviceState(site)
  return (
    <Status tone={state.tone} className={cn(state.tone === "neutral" && "text-muted-foreground", className)}>
      {state.label}
    </Status>
  )
}

function ServiceCell({ site, now }: { site: Site; now: number }) {
  const summary = serviceSummaryOf(site, now)
  return (
    <div className="grid justify-items-start gap-0.5">
      {/* The word and the CPU share on the first, short line; the memory and its bar below. */}
      <span className="flex flex-wrap items-baseline gap-x-2">
        <ServiceWord site={site} />
        {summary.kind === "active" && summary.cpu !== null && (
          <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{summary.cpu}</span>
        )}
      </span>
      {summary.kind === "active" && (
        <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <MemoryBar summary={summary} />
          {summary.memory}
        </span>
      )}
      {summary.kind === "stopped" && summary.restarts !== null && (
        <span className="text-xs text-attention-text tabular-nums">{summary.restarts}</span>
      )}
    </div>
  )
}

/** The active guest accesses of a site behind the portal, beside its door: zero is not written. */
function ActiveGuests({ count, className }: { count: number | undefined; className?: string }) {
  if (count === undefined || count === 0) return null
  return (
    <span className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      {count === 1 ? "1 active guest" : `${count} active guests`}
    </span>
  )
}

const HEAD = "h-9 px-3 text-xs font-medium text-muted-foreground"
const CELL = "px-3 py-2.5 align-top whitespace-normal"

type RowProps = { site: SiteWithSecrets; severity: Severity | null; guests: number | undefined; now: number }

function SiteRow({ site, severity, guests, now }: RowProps) {
  const click = useRowClick(siteUrl(site.slug))
  const access = siteAccess(site)
  return (
    <TableRow {...click} className="group/row cursor-pointer hover:bg-muted/40">
      <TableCell className={cn(CELL, "pl-4")}>
        <div className="flex gap-2.5">
          <Gutter severity={severity} />
          <div className="grid min-w-0 gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <SiteName slug={site.slug} />
              {site.restartPending === true && <PendingPill />}
            </span>
            {site.description !== null && (
              <span lang="fr" className="text-xs text-muted-foreground">
                {site.description}
              </span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className={CELL}>
        <AddressCell address={siteAddress(site)} />
      </TableCell>
      <TableCell className={CELL}>
        <div className="grid justify-items-start gap-0.5">
          <Gate site={site} />
          {access.kind === "portal" && access.exemptions.length > 0 && (
            <span className="text-xs text-muted-foreground" title="Public paths, guarded by the site alone">
              <span className="font-mono">{access.exemptions.join(" ")}</span> public
            </span>
          )}
          <ActiveGuests count={guests} />
        </div>
      </TableCell>
      <TableCell className={CELL}>
        <ServiceCell site={site} now={now} />
      </TableCell>
      <TableCell className={cn(CELL, "pr-4 text-right tabular-nums")}>
        <div className="grid gap-0.5 whitespace-nowrap">
          <span>{size(site.bytes)}</span>
          {site.deployed !== null && (
            <span className="text-xs text-muted-foreground" title="Last deployed">
              <span className="sr-only">Deployed </span>
              {ago(now - site.deployed)}
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * An entry in the mobile list: the name and the service's state on the first
 * line, the description, the address, then the door and the sizes. The whole
 * entry leads to the site, like a table row.
 */
function SiteEntry({ site, severity, guests, now }: RowProps) {
  const click = useRowClick(siteUrl(site.slug))
  const summary = serviceSummaryOf(site, now)
  const address = siteAddress(site)
  return (
    <li {...click} className="group/row flex cursor-pointer gap-2.5 px-4 py-3 active:bg-muted/40">
      <Gutter severity={severity} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <SiteName slug={site.slug} />
            {site.restartPending === true && <PendingPill />}
          </span>
          <ServiceWord site={site} className="shrink-0" />
        </div>
        {site.description !== null && (
          <p lang="fr" className="-mt-0.5 truncate text-xs text-muted-foreground">
            {site.description}
          </p>
        )}
        <AddressCell address={address} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground">
            <Gate site={site} large />
          </span>
          <ActiveGuests count={guests} />
          {summary.kind === "active" && (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <MemoryBar summary={summary} className="w-8" />
              {summary.memory}
            </span>
          )}
          {summary.kind === "stopped" && summary.restarts !== null && (
            <span className="text-attention-text">{summary.restarts}</span>
          )}
          {site.bytes !== null && <span className="whitespace-nowrap">{size(site.bytes)} on disk</span>}
        </div>
      </div>
    </li>
  )
}

/**
 * The inventory: a table when the panel has room for its five columns, a list
 * otherwise. The measurement is the panel's and not the screen's: at 1024 px
 * the expanded sidebar takes 256 of them, and the table would overflow. The
 * order and the filter are already applied; the caption states them to screen
 * readers.
 */
export function SiteList({
  sites,
  worst,
  activeGuests,
  now,
  caption,
}: {
  sites: readonly SiteWithSecrets[]
  worst: ReadonlyMap<string, Severity>
  /** The active accesses by host; null until the portal has answered. */
  activeGuests: ReadonlyMap<string, number> | null
  now: number
  caption: string
}) {
  return (
    <Panel full>
      <div className="@container">
        <Table className="hidden table-fixed @4xl:table">
          <caption className="sr-only">{caption}</caption>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "w-[24%] pl-4")}>
                <span className="pl-6.5">Site</span>
              </TableHead>
              <TableHead className={cn(HEAD, "w-[27%]")}>Address</TableHead>
              <TableHead className={cn(HEAD, "w-[18%]")}>Access</TableHead>
              <TableHead className={cn(HEAD, "w-[21%]")}>Service</TableHead>
              <TableHead className={cn(HEAD, "w-[10%] pr-4 text-right")}>Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((site) => (
              <SiteRow
                key={site.slug}
                site={site}
                severity={worst.get(site.slug) ?? null}
                guests={activeGuests?.get(site.address)}
                now={now}
              />
            ))}
          </TableBody>
        </Table>

        <ul aria-label={caption} className="divide-y @4xl:hidden">
          {sites.map((site) => (
            <SiteEntry
              key={site.slug}
              site={site}
              severity={worst.get(site.slug) ?? null}
              guests={activeGuests?.get(site.address)}
              now={now}
            />
          ))}
        </ul>
      </div>
    </Panel>
  )
}
