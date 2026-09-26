import { useState } from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useData } from "@/components/data"
import { ErrorState, Panel, RowsSkeleton, Status } from "@/components/page"
import { useSecretsActions } from "@/components/secrets-actions"
import { SectionLink } from "@/components/site"
import { ago } from "@/lib/format"
import { UNREACHABLE, PENDING_LABEL, splitReason, pendingFiles, fileOffer, fileSummary } from "@/lib/secrets"
import type { ProjectView } from "@/lib/types"

/**
 * The service itself is not repeated here: Overview's Service panel already
 * shows it. What is left is what the secrets say of it, the restart that is
 * pending.
 */
function Content({ project }: { project: ProjectView }) {
  const actions = useSecretsActions()
  const wait = pendingFiles(project)

  return (
    <>
      {wait.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <Status tone="attention" shape="pill">
            {PENDING_LABEL}
          </Status>
          <p className="min-w-0 flex-1 basis-48 text-xs text-pretty text-muted-foreground">
            {wait.map((name, index) => (
              <span key={name}>
                {index > 0 && ", "}
                <span className="font-mono">{name}</span>
              </span>
            ))}{" "}
            changed after {project.slug} last started.
          </p>
          {project.service !== null && (
            <Button variant="outline" size="sm" onClick={() => actions.restart(project.slug)} className="max-md:h-10">
              <RotateCcw />
              Restart service
            </Button>
          )}
        </div>
      )}

      {/*
        A summary, not an inventory: each variable's name is read in the Secrets
        section, where Manage leads. Here, one file per row, what it holds in
        one sentence, and its state only if it calls for an action.
      */}
      <ul aria-label={`Secret files of ${project.slug}`} className="divide-y">
        {project.files.map((file) => {
          const count = fileSummary(file)
          const reason = file.state === "unmanaged" ? splitReason(file.reason ?? "").text : null
          const detail =
            file.state === "absent"
              ? "Declared, but not on the server"
              : reason !== null
                ? reason
                : [
                    fileOffer(file).writeOnly ? "Write-only" : null,
                    count,
                    file.modifiedAt !== null ? `changed ${ago(actions.serverNow - file.modifiedAt)}` : null,
                  ]
                    .filter((piece): piece is string => piece !== null)
                    .join(", ")
          return (
            <li key={file.name} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="text-sm font-medium wrap-anywhere">{file.name}</span>
                {detail !== "" && <span className="text-xs text-pretty text-muted-foreground tabular-nums">{detail}</span>}
              </div>
              {file.state === "absent" && <Status tone="error">Missing</Status>}
              {file.state === "unmanaged" && <Status tone="attention">Unmanaged</Status>}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * A site's secrets, on its Overview: its files, what they hold in one sentence,
 * their state and the restart pending. No value and no variable name: the
 * inventory belongs to the Secrets section. The only action is the restart;
 * everything else is done in the Secrets section, where *Manage* leads.
 *
 * Nothing for a site with no secret file. As long as the secrets have not been
 * read, or if the steward does not answer, the panel is only shown for a site
 * that declares secrets in its manifest.
 */
export function SiteSecretsPanel({ slug }: { slug: string }) {
  const { secrets, snapshot } = useData()
  const { projects, problem, reload } = secrets
  const [rereading, setRereading] = useState(false)
  const project = projects?.find((candidate) => candidate.slug === slug) ?? null

  async function retry() {
    setRereading(true)
    try {
      await reload()
    } finally {
      setRereading(false)
    }
  }

  if (project === null) {
    const site = snapshot?.sites.find((candidate) => candidate.slug === slug)
    const declare = site !== undefined && site.secrets.length > 0
    if (projects !== null || !declare) return null
    return (
      <Panel title="Secrets" full actions={<SectionLink slug={slug} section="secrets" />}>
        {problem === null ? (
          <div aria-busy="true" aria-label="Loading secrets">
            <RowsSkeleton lines={2} />
          </div>
        ) : (
          <ErrorState title={problem} onRetry={() => void retry()} inProgress={rereading} compact>
            {problem === UNREACHABLE && (
              <>
                Check <code className="font-mono text-xs whitespace-nowrap">systemctl status sitesolide-steward</code> on
                the server.
              </>
            )}
          </ErrorState>
        )}
      </Panel>
    )
  }

  if (project.files.length === 0) return null

  return (
    <Panel title="Secrets" count={project.files.length} full actions={<SectionLink slug={slug} section="secrets" />}>
      <Content project={project} />
    </Panel>
  )
}
