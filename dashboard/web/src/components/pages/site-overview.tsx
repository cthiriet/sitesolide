import { useEffect, useState, type ReactNode } from "react"
import { useData } from "@/components/data"
import { KindIcon } from "@/components/legend"
import { ExternalLink } from "@/components/link"
import { PanelSkeleton, StateLabel } from "@/components/page"
import { RestartButton } from "@/components/restart-button"
import { SitePage, useSite } from "@/components/site"
import { SiteDiscrepancies, ServicePanel, ServicesPanel, SitePanel, type Headline } from "@/components/site-card"
import { readAccess, readBackups } from "@/lib/api"
import { isPlatform, listCount } from "@/lib/access"
import { isAuditResponse, readAudit } from "@/lib/audit"
import { freshness } from "@/lib/backups"
import { historyRequest } from "@/lib/history"
import { isPerson, mayRestart, roleOn } from "@/lib/identity"
import { sectionsFor, siteUrl, type Section } from "@/lib/pages"
import { audienceHeadline, deployedBy, headerState, kindLine, secretsHeadline } from "@/lib/site-card"
import { siteAddress } from "@/lib/sites"
import { TONE_TEXT } from "@/lib/tones"
import type { AuditRow, BackupsView, Discrepancy, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Under the title: what the project is, its kind's icon and word with how
 * many services it runs; its state, only when it is not fine; its
 * description; its main address, which a project serving no page does not
 * offer as a page.
 */
function Summary({ site, discrepancies }: { site: Site; discrepancies: readonly Discrepancy[] }) {
  const kind = kindLine(site)
  const state = headerState(site, discrepancies)
  const address = siteAddress(site)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="inline-flex items-center gap-1.5 text-secondary-foreground">
        <KindIcon kind={kind.kind} />
        {kind.text}
      </span>
      {state !== null && <StateLabel tone={state.tone}>{state.label}</StateLabel>}
      {site.description !== null && <span lang="fr">{site.description}</span>}
      {!site.headless && (
        <ExternalLink href={address.href} className="font-mono text-[0.8125rem] text-foreground">
          {address.text}
        </ExternalLink>
      )}
    </div>
  )
}

/**
 * Who is on the list, in a few words, for the Access line: read with the
 * snapshot, and nothing said until it answers or for the platform's own
 * projects, which nobody is given a role on.
 */
function usePeople(slug: string, enabled: boolean, restricted: boolean): string | null {
  const { generation } = useData()
  const [people, setPeople] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    void readAccess(slug).then(({ status, body }) => {
      if (!current || status !== 200 || body === null || !Array.isArray(body.entries)) return
      // An empty list only says something of a restricted site: nobody but the owner opens it.
      setPeople(body.entries.length === 0 && !restricted ? null : listCount(body.entries))
    })
    return () => {
      current = false
    }
  }, [slug, enabled, restricted, generation])
  return enabled ? people : null
}

/**
 * The Backups line: how fresh the last snapshot is, read from the steward
 * with the snapshot, in the Backups section's own words; red when the last
 * run failed. Muted words when the steward can't say.
 */
function useBackups(slug: string, enabled: boolean): Headline | null {
  const { generation, now, offset } = useData()
  const [read, setRead] = useState<{ view: BackupsView } | { message: string } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    void readBackups(slug).then(({ status, body }) => {
      if (!current) return
      if (status === 200 && body !== null && typeof body.backups === "object" && body.backups !== null) return setRead({ view: body.backups })
      setRead({ message: status === 404 ? "Not on this server's steward yet" : "Can't read them right now" })
    })
    return () => {
      current = false
    }
  }, [slug, enabled, generation])
  if (!enabled) return null
  if (read === null) return { state: "loading" }
  if ("message" in read) return { state: "ready", content: <Muted>{read.message}</Muted> }
  if (!read.view.installed) return { state: "ready", content: <Muted>Not set up on this server</Muted> }
  // The age moves on with the page's clock, between two reads.
  const reading = freshness(read.view, now + offset)
  return { state: "ready", content: <Toned tone={reading.tone}>{reading.label}</Toned> }
}

/**
 * Who made the last deployment, when Activity knows it: the latest success
 * recorded for the site, kept only when it is the deployment the manifest
 * dates (lib/site-card.ts `deployedBy`).
 */
function useDeployedBy(slug: string, deployed: number | null): string | null {
  const [rows, setRows] = useState<readonly AuditRow[]>([])
  useEffect(() => {
    if (deployed === null) return
    let current = true
    const { query } = historyRequest({ target: slug, action: "deploy.success" }, Date.now(), 1)
    void readAudit(query).then(({ status, body }) => {
      if (current && status === 200 && isAuditResponse(body)) setRows(body.rows)
    })
    return () => {
      current = false
    }
  }, [slug, deployed])
  return deployedBy(rows, deployed)
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/** A headline in its tone: plain when fine, the state's word in its colour otherwise. */
function Toned({ tone, children }: { tone: "ok" | "neutral" | "attention" | "error"; children: string }) {
  if (tone === "ok") return <span>{children}</span>
  if (tone === "neutral") return <Muted>{children}</Muted>
  return <span className={cn("font-medium", TONE_TEXT[tone])}>{children}</span>
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid items-start gap-6 @4xl/body:grid-cols-2">
      <PanelSkeleton lines={5} />
      <PanelSkeleton lines={7} />
    </div>
  )
}

/**
 * A site's Overview, under `/site/?s=<slug>`: the hub of its sections. Its
 * discrepancies first, one line each; then two panels side by side, the
 * Service, the facts of its main unit, and the Site, one line per section
 * with its headline and a chevron to it; the Services table under both for a
 * project that runs several. A single column below that width, in that
 * order. A static site runs no service: the Site panel is alone.
 */
export function OverviewSection({ slug }: { slug: string }) {
  const { now, offset, identity, snapshot: data, reading, secrets } = useData()
  const { site, discrepancies, project } = useSite(slug)
  const allowed = new Set<Section>(sectionsFor(identity, slug).map((entry) => entry.section))
  const link = (section: Section) => (allowed.has(section) ? siteUrl(slug, section) : null)
  const platform = isPlatform(slug, data?.zone ?? null)
  const people = usePeople(slug, !platform, site !== null && site.portal.installed)
  const backups = useBackups(slug, allowed.has("backups"))
  const person = isPerson(identity)
  const deployedBy = useDeployedBy(slug, site?.deployed ?? null)
  const audience = reading !== null && reading.present ? reading.audience : null

  // The secrets line: what the store keeps, once the steward has said it; nothing to say for a site it does not list.
  const secretsLine: Headline | null = !allowed.has("secrets")
    ? null
    : project !== null
      ? (() => {
          const headline = secretsHeadline(project, now + offset)
          return {
            state: "ready",
            content: (
              <>
                <span className={cn(headline.text === "None" && "text-muted-foreground")}>{headline.text}</span>
                {headline.problem !== null && (
                  <StateLabel tone={headline.problem.tone} more={headline.problem.more} title={headline.problem.title}>
                    {headline.problem.text}
                  </StateLabel>
                )}
              </>
            ),
          }
        })()
      : secrets.projects === null && secrets.problem === null
        ? { state: "loading" }
        : { state: "ready", content: <Muted>{secrets.problem === null ? "None" : "Can't read them right now"}</Muted> }

  const audienceLine: Headline | null = link("audience") === null ? null : (() => {
    const headline = audienceHeadline(audience, slug)
    return { state: "ready", content: headline.measured ? <span className="tabular-nums">{headline.text}</span> : <Muted>{headline.text}</Muted> }
  })()

  return (
    <SitePage
      slug={slug}
      section="overview"
      history={{ target: slug }}
      description={site === null ? undefined : <Summary site={site} discrepancies={discrepancies} />}
      skeleton={<OverviewSkeleton />}
    >
      {(snapshot) => {
        const service = (
          <ServicePanel
            site={snapshot}
            now={now}
            action={mayRestart(identity, slug) && snapshot.type === "app" ? <RestartButton slug={slug} /> : undefined}
          />
        )
        return (
          <>
            <SiteDiscrepancies discrepancies={discrepancies} />
            <div className="grid items-start gap-6 @4xl/body:grid-cols-2">
              {service}
              <SitePanel
                site={snapshot}
                now={now}
                links={{ access: siteUrl(slug, "access"), secrets: link("secrets"), backups: link("backups"), audience: link("audience") }}
                people={people}
                plainAccess={person && roleOn(identity, slug) !== "admin"}
                secrets={secretsLine}
                backups={backups}
                audience={audienceLine}
                deployedBy={deployedBy}
              />
              <div className="min-w-0 @4xl/body:col-span-2 empty:hidden">
                <ServicesPanel site={snapshot} now={now} />
              </div>
            </div>
          </>
        )
      }}
    </SitePage>
  )
}
