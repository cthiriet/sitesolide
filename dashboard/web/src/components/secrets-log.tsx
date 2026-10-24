import { useCallback, useEffect, useState } from "react"
import { History } from "lucide-react"
import { useData } from "@/components/data"
import { ErrorState, EmptyState, Panel, RowsSkeleton, Status, When } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { readSecretsLog } from "@/lib/api"
import {
  latestOperations,
  operationOutcome,
  refusalOf,
  operationFile,
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

/**
 * A site's latest operations through the steward, the most recent at the top:
 * a table when the panel has room for its columns, a list otherwise. Read on
 * opening, on every snapshot and after every action. The log never contains a
 * value, nor the hash of a value.
 */
export function SecretsLog({ slug }: { slug: string }) {
  const { generation, sessionExpired } = useData()
  const { revision, serverNow } = useSecretsActions()
  const [list, setList] = useState<ListState>({ state: "loading" })
  const [rereading, setRereading] = useState(false)

  const load = useCallback(async () => {
    const { status, body } = await readSecretsLog(slug)
    if (status === 200 && body !== null && Array.isArray(body.entries)) {
      return setList({ state: "ready", entries: latestOperations(siteOperations(body.entries, slug)) })
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

  const caption = `Recent operations on ${slug}, most recent first`

  return (
    <Panel title="Activity" full>
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
          Reads, changes, restarts and access changes on {slug} show up here.
        </EmptyState>
      )}

      {list.state === "ready" && list.entries.length > 0 && (
        <div className="@container">
          <table className="hidden w-full text-sm @2xl:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="h-10 border-b bg-muted text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 pl-4 font-medium">
                  Operation
                </th>
                <th scope="col" className="px-3 font-medium">
                  Result
                </th>
                <th scope="col" className="px-3 font-medium">
                  File
                </th>
                <th scope="col" className="px-3 pr-4 text-right font-medium">
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {list.entries.map((entry, index) => {
                const file = operationFile(entry)
                return (
                  <tr key={`${entry.a}-${index}`}>
                    <td className="px-3 py-3 pl-4">
                      <Operation entry={entry} />
                    </td>
                    <td className="px-3 py-3">
                      <Outcome entry={entry} />
                    </td>
                    <td className="px-3 py-3">
                      {file !== null && <code className="font-mono text-xs">{file}</code>}
                    </td>
                    <td className="px-3 py-3 pr-4 text-right">
                      <When at={entry.a} serverNow={serverNow} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ol aria-label={caption} className="divide-y divide-divider @2xl:hidden">
            {list.entries.map((entry, index) => {
              const file = operationFile(entry)
              const outcome = operationOutcome(entry)
              return (
                <li key={`${entry.a}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                  <span className="text-sm">
                    <Operation entry={entry} />
                  </span>
                  <span className="text-xs">
                    <When at={entry.a} serverNow={serverNow} />
                  </span>
                  {(file !== null || outcome.text !== null) && (
                    <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {outcome.text !== null && <Outcome entry={entry} />}
                      {file !== null && <code className="font-mono">{file}</code>}
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
