import { useCallback, useEffect, useState } from "react"
import { History } from "lucide-react"
import { useData } from "@/components/data"
import { InternalLink } from "@/components/navigation"
import { ErrorState, EmptyState, Panel, RowsSkeleton, Status } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { readSecretsLog } from "@/lib/api"
import { ABSENT, dateTime, ago } from "@/lib/format"
import { siteUrl } from "@/lib/pages"
import {
  latestOperations,
  operationOutcome,
  refusalOf,
  operationPlace,
  siteOperations,
  operationParts,
} from "@/lib/secrets"
import type { LogEntry } from "@/lib/types"

type ListState = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; entries: LogEntry[] }

function Operation({ entry }: { entry: LogEntry }) {
  const { verb, object, kind } = operationParts(entry)
  return (
    <span className="wrap-anywhere">
      {verb}
      {object !== null && " "}
      {object !== null && (kind === "project" ? <span className="font-medium">{object}</span> : <code className="font-mono text-[0.8125rem]">{object}</code>)}
    </span>
  )
}

function Outcome({ entry }: { entry: LogEntry }) {
  const outcome = operationOutcome(entry)
  if (outcome.text === null) return <span className="text-muted-foreground">Done</span>
  return (
    <Status tone={outcome.tone} className="whitespace-normal">
      {outcome.text}
    </Status>
  )
}

function When({ a, serverNow }: { a: number; serverNow: number }) {
  // An unreadable date must not bring the page down: Date and Intl throw on NaN.
  if (!Number.isFinite(a)) return <span className="text-muted-foreground">{ABSENT}</span>
  return (
    <time
      dateTime={new Date(a).toISOString()}
      title={dateTime(a)}
      className="whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {ago(serverNow - a)}
    </time>
  )
}

function ProjectLink({ slug, known }: { slug: string | null; known: ReadonlySet<string> }) {
  if (slug === null) return null
  if (!known.has(slug)) return <span>{slug}</span>
  return (
    <InternalLink
      href={siteUrl(slug, "secrets")}
      className="rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {slug}
    </InternalLink>
  )
}

/**
 * The steward's latest operations, the most recent at the top: a table when the
 * panel has room for its columns, a list otherwise. Read on opening, on every
 * snapshot and after every action. The log never contains a value, nor the hash
 * of a value.
 *
 * With `slug`, those of a single site, without the site column; without it,
 * those of the whole machine.
 */
export function SecretsLog({ slug = null }: { slug?: string | null }) {
  const { generation, snapshot, sessionExpired } = useData()
  const { revision, serverNow } = useSecretsActions()
  const [list, setList] = useState<ListState>({ state: "loading" })
  const [rereading, setRereading] = useState(false)

  const load = useCallback(async () => {
    const { status, body } = await readSecretsLog(slug)
    if (status === 200 && body !== null && Array.isArray(body.entries)) {
      const entries = slug === null ? body.entries : siteOperations(body.entries, slug)
      return setList({ state: "ready", entries: latestOperations(entries) })
    }
    const outcome = refusalOf(status, body)
    if (outcome.kind === "session") return sessionExpired()
    const message = outcome.kind === "locked" ? "Unlock to see the activity." : outcome.message
    // A failed re-read keeps the list already there: past activity has not disappeared.
    setList((before) => (before.state === "ready" ? before : { state: "error", message }))
  }, [sessionExpired, slug])

  useEffect(() => {
    void load()
  }, [generation, revision, load])

  async function retry() {
    setRereading(true)
    try {
      await load()
    } finally {
      setRereading(false)
    }
  }

  const known = new Set(snapshot?.sites.map((site) => site.slug) ?? [])
  const withSite = slug === null
  const caption = withSite ? "Recent operations, most recent first" : `Recent operations on ${slug}, most recent first`

  return (
    <Panel title="Activity" description="Newest first. Values never appear here." full>
      {list.state === "loading" && (
        <div aria-busy="true" aria-label="Loading activity">
          <RowsSkeleton lines={4} />
        </div>
      )}

      {list.state === "error" && (
        <ErrorState title={list.message} onRetry={() => void retry()} inProgress={rereading} compact />
      )}

      {list.state === "ready" && list.entries.length === 0 && (
        <EmptyState icon={History} title="No activity yet" compact>
          {withSite ? "Unlocks, reads, changes, restarts and portal changes show up here." : `Reads, changes, restarts and portal changes on ${slug} show up here.`}
        </EmptyState>
      )}

      {list.state === "ready" && list.entries.length > 0 && (
        <div className="@container">
          <table className="hidden w-full text-sm @2xl:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="h-9 border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 pl-4 font-medium">
                  Operation
                </th>
                <th scope="col" className="px-3 font-medium">
                  Result
                </th>
                {withSite && (
                  <th scope="col" className="px-3 font-medium">
                    Site
                  </th>
                )}
                <th scope="col" className="px-3 font-medium">
                  File
                </th>
                <th scope="col" className="px-3 pr-4 text-right font-medium">
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.entries.map((entry, index) => {
                const place = operationPlace(entry)
                return (
                  <tr key={`${entry.a}-${index}`}>
                    <td className="px-3 py-2.5 pl-4">
                      <Operation entry={entry} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Outcome entry={entry} />
                    </td>
                    {withSite && (
                      <td className="px-3 py-2.5">
                        <ProjectLink slug={place.project} known={known} />
                      </td>
                    )}
                    <td className="px-3 py-2.5">
                      {place.file !== null && <code className="font-mono text-xs">{place.file}</code>}
                    </td>
                    <td className="px-3 py-2.5 pr-4 text-right">
                      <When a={entry.a} serverNow={serverNow} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ol aria-label={caption} className="divide-y @2xl:hidden">
            {list.entries.map((entry, index) => {
              const place = operationPlace(entry)
              const outcome = operationOutcome(entry)
              return (
                <li key={`${entry.a}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                  <span className="text-sm">
                    <Operation entry={entry} />
                  </span>
                  <span className="text-xs">
                    <When a={entry.a} serverNow={serverNow} />
                  </span>
                  {((withSite && place.project !== null) || place.file !== null || outcome.text !== null) && (
                    <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {outcome.text !== null && <Outcome entry={entry} />}
                      {withSite && place.project !== null && <ProjectLink slug={place.project} known={known} />}
                      {place.file !== null && <code className="font-mono">{place.file}</code>}
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Panel>
  )
}
