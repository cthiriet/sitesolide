import { useMemo } from "react"
import { ArrowDownLeft, ArrowUpRight, Files, Workflow } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Command } from "@/components/copy"
import { MemoryUsage } from "@/components/gauge"
import { useData } from "@/components/data"
import { DetailSheet, SheetFacts, SheetSection, useSheet, type Fact } from "@/components/detail-sheet"
import { InternalLink } from "@/components/navigation"
import { Banner, EmptyState, Panel, StateLabel } from "@/components/page"
import { ServiceMap } from "@/components/service-map"
import { SitePage, useSite } from "@/components/site"
import { duration } from "@/lib/format"
import { siteUrl } from "@/lib/pages"
import { EDGE_WORDS, buildMap, declaredLine, edgeLine, edgeShort, kindLabel, nodeState, routeLabel, scheduleLabel, type MapEdge, type ServiceMap as Graph } from "@/lib/service-map"
import { computeCpuShare, memoryReading, runLines } from "@/lib/sites"
import type { Site, SiteService } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's Services, under `/site/services/?s=<slug>`: its services on a
 * canvas, who talks to whom, from visitors to what leaves the machine, and
 * a service's details in the sheet its card opens, `?service=<unit>`. The
 * section of an app alone: a static site runs nothing to draw.
 */

function Intro({ slug }: { slug: string }) {
  return (
    <>
      <p>
        Each of {slug}'s services, and who talks to whom. A solid line is a connection seen on the loopback, open now when it is dark, earlier when
        it is pale; a dashed one is only declared, a port named in sitesolide.json that nothing was seen using yet.
      </p>
      <p className="mt-2">
        The server reads its connections once a minute and remembers each for a week: a call that comes and goes between two readings shows once
        a reading falls on it. Where you drag a card is kept in this browser alone.
      </p>
    </>
  )
}

/** The canvas takes the height the page leaves it, under the header, above the tabs on a phone. */
const CANVAS_HEIGHT = "h-[calc(100dvh-var(--page-header,4.25rem)-4.5rem)] min-h-[26rem] max-md:h-[calc(100dvh-var(--page-header,7rem)-8.5rem)]"

/** What a node is called in a sheet's list of connections. */
function nodeName(id: string, site: Site): string {
  switch (id) {
    case "visitors":
      return "Visitors"
    case "outside":
      return "Another process"
    case "files":
      return "Static files"
    case "egress":
      return "Egress proxy"
    case "connectors":
      return "Connectors"
    case "internet":
      return "Any host"
    default: {
      const service = site.services.find((candidate) => candidate.unit === id)
      return service?.name ?? id
    }
  }
}

/** A service's facts, as the Overview's panel gives the main one's, its schedule and what it keeps besides. */
function serviceFacts(service: SiteService, now: number): Fact[] {
  const unit = service.service
  const facts: Fact[] = []
  const running = unit !== null && unit.active === "active"
  if (service.kind === "scheduled") {
    const schedule = scheduleLabel(service)
    const runs = runLines(service, now)
    if (schedule !== null) facts.push({ label: "Schedule", value: <span className={cn(schedule.mono && "font-mono text-[0.8125rem]")}>{schedule.text}</span> })
    if (runs.last !== null) {
      // "Last run 19h ago" under a label that already says it: the age alone.
      const text = runs.last.text.replace(/^Last run /, "")
      facts.push({ label: "Last run", value: runs.last.tone === "neutral" ? text : <StateLabel tone={runs.last.tone}>{text}</StateLabel> })
    }
    if (runs.next !== null) facts.push({ label: "Next run", value: runs.next.replace(/^Next run /, "") })
    if (service.schedule !== null) facts.push({ label: "Timeout", value: service.schedule.timeout })
  } else if (running) {
    facts.push({ label: "Up", value: unit.since === null ? "Running" : duration(now - unit.since) })
  }
  if (running && unit.memory !== null) facts.push({ label: "Memory", value: <MemoryUsage reading={memoryReading(unit.memory, unit.peak, unit.limit, true)} muted={false} /> })
  if (running && unit.cpuShare !== null) facts.push({ label: "CPU", value: `${computeCpuShare(unit.cpuShare)} of one core` })
  if (unit !== null && (unit.restarts ?? 0) > 0) facts.push({ label: "Restarts", value: String(unit.restarts) })
  if (service.port !== null)
    facts.push({
      label: "Port",
      value:
        service.listening === false ? (
          <span className="font-medium text-destructive">{service.port}, nothing listens on it</span>
        ) : (
          <span className="font-mono text-[0.8125rem]">127.0.0.1:{service.port}</span>
        ),
    })
  if (!service.internal && service.port !== null) facts.push({ label: "Paths", value: <span className={cn(service.routes !== null && "font-mono text-[0.8125rem]")}>{routeLabel(service.routes ?? [])}</span> })
  if (service.backup !== null) facts.push({ label: "Keeps", value: <span className="font-mono text-[0.8125rem]">data/{service.backup}</span> })
  facts.push({ label: "Unit", value: <span className="font-mono text-[0.8125rem]">{service.unit}.service</span> })
  return facts
}

/** One connection in a service's sheet: which way, the other end and the paths it carries, how sure it is, and what declares it. */
function ConnectionRow({ edge, unit, site, now }: { edge: MapEdge; unit: string; site: Site; now: number }) {
  const inbound = edge.to === unit
  const other = nodeName(inbound ? edge.from : edge.to, site)
  const Icon = inbound ? ArrowDownLeft : ArrowUpRight
  const declared = declaredLine(edge)
  return (
    <li className="flex min-h-11 items-start gap-3 py-2">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", edge.state === "open" ? "text-foreground" : "text-muted-foreground")} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">{inbound ? "From " : "To "}</span>
          <span className="font-medium text-strong">{other}</span>
          {edge.label !== null && <span className={cn("ml-2 text-xs text-muted-foreground", edge.routes !== null && edge.routes.length > 0 && "font-mono")}>{edge.label}</span>}
        </span>
        {declared !== null && <span className="text-xs text-muted-foreground">{declared}</span>}
      </div>
      <span title={edgeLine(edge, now)} className={cn("shrink-0 pt-0.5 text-xs tabular-nums", edge.state === "open" ? "font-medium text-foreground" : "text-muted-foreground")}>
        {edgeShort(edge, now)}
        <span className="sr-only">, {EDGE_WORDS[edge.state]}</span>
      </span>
    </li>
  )
}

function ServiceSheet({ site, graph, unit, now, onClose }: { site: Site; graph: Graph; unit: string | null; now: number; onClose: () => void }) {
  const service = unit === null ? null : (site.services.find((candidate) => candidate.unit === unit) ?? null)
  const state = service === null ? null : nodeState(service)
  const edges = service === null ? [] : graph.edges.filter((edge) => edge.from === service.unit || edge.to === service.unit)
  // Who reaches it first, then what it reaches; the surest first in each.
  const rank = { open: 0, seen: 1, routed: 2, declared: 3 }
  const sorted = [...edges].sort((a, b) => Number(a.from === unit) - Number(b.from === unit) || rank[a.state] - rank[b.state])
  return (
    <DetailSheet
      open={service !== null}
      onClose={onClose}
      title={service?.name ?? service?.unit ?? ""}
      state={state !== null && <StateLabel tone={state.tone}>{state.label}</StateLabel>}
      description={service === null ? undefined : `${kindLabel(service)}${service.main ? ", the project's main service" : ""}`}
      history={{ target: site.slug, type: "deployments" }}
    >
      {service !== null && (
        <>
          <SheetFacts facts={serviceFacts(service, now)} />
          <SheetSection title={`Connections${edges.length === 0 ? "" : ` (${edges.length})`}`}>
            {sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground">None seen or declared. It talks to nothing on the loopback that the server has seen.</p>
            ) : (
              <ul className="divide-y divide-divider text-sm">
                {sorted.map((edge) => (
                  <ConnectionRow key={edge.id} edge={edge} unit={service.unit} site={site} now={now} />
                ))}
              </ul>
            )}
          </SheetSection>
          <SheetSection title="Logs">
            <p className="text-sm text-muted-foreground">
              In the project's folder: every service's journal, interleaved, this one's under <code className="font-mono text-xs">{service.unit}.service</code>.
            </p>
            <Command text="sitesolide logs --follow" />
          </SheetSection>
        </>
      )}
    </DetailSheet>
  )
}

/** A static site, or a folder with no manifest: nothing runs, so nothing to draw. */
function NothingRuns({ site }: { site: Site }) {
  return (
    <Panel>
      <EmptyState
        icon={site.type === "static" ? Files : Workflow}
        title={`${site.slug} runs no service`}
        action={
          <InternalLink href={siteUrl(site.slug)} className={cn(buttonVariants({ variant: "outline" }), "max-md:h-10")}>
            Open its Overview
          </InternalLink>
        }
      >
        {site.type === "static" ? "Caddy serves its files, and nothing else runs." : "Without a sitesolide.json, the server runs nothing for it."}
      </EmptyState>
    </Panel>
  )
}

function Content({ site, connections }: { site: Site; connections: boolean }) {
  const { now, offset } = useData()
  const sheet = useSheet("service")
  const graph = useMemo(() => buildMap(site), [site])
  const serverNow = now + offset
  if (site.type !== "app") return <NothingRuns site={site} />
  return (
    <>
      {!connections && (
        <Banner tone="attention">
          This server doesn't read its connections yet: the map shows what sitesolide.json declares. Run sitesolide upgrade to see who talks to whom.
        </Banner>
      )}
      <ServiceMap site={site} now={serverNow} selected={sheet.id} onSelect={sheet.open} className={CANVAS_HEIGHT} />
      <ServiceSheet site={site} graph={graph} unit={sheet.id} now={serverNow} onClose={sheet.close} />
    </>
  )
}

export function ServicesSection({ slug }: { slug: string }) {
  const { snapshot } = useData()
  const { site } = useSite(slug)
  const count = site === null || site.type !== "app" ? undefined : site.services.length
  return (
    <SitePage
      slug={slug}
      section="services"
      wide
      count={count}
      intro={<Intro slug={slug} />}
      history={{ target: slug, type: "deployments" }}
      skeleton={<div aria-busy="true" aria-label="Loading" className={cn(CANVAS_HEIGHT, "animate-pulse rounded-xl border bg-sunk shadow-well")} />}
    >
      {(found) => <Content site={found} connections={snapshot?.connections ?? true} />}
    </SitePage>
  )
}
