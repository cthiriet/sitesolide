import { type ReactNode } from "react"
import { FilePlus, FileText, Plus, RotateCcw, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command } from "@/components/copy"
import { EmptyState, SeverityIcon, Panel, Status } from "@/components/page"
import { fileKey, useSecretsActions, type FileTarget } from "@/components/secrets-actions"
import { LockGlyph } from "@/components/unlock"
import { VariablesHeader, PasswordRow, VariableRow } from "@/components/secrets-variables"
import { ago } from "@/lib/format"
import {
  splitReason,
  readService,
  fileOffer,
  variableOffer,
  projectProblems,
  fileSummary,
  type Problem,
} from "@/lib/secrets"
import type { FileView, ProjectView } from "@/lib/types"

// --- A file ----------------------------------------------------------------------

function Terminal({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs whitespace-nowrap">{children}</code>
}

/**
 * One file, a card of its own with its name on a tinted bar: as rows of one
 * table, two files read as one, the column header weighing more than the name
 * that starts the next file.
 */
function FileBlock({ slug, file }: { slug: string; file: FileView }) {
  const actions = useSecretsActions()
  const target: FileTarget = { slug, file: file.name }
  const key = fileKey(target)
  const error = actions.errors[key] ?? ""
  const offer = fileOffer(file)
  const count = fileSummary(file)
  const change = file.modifiedAt === null ? null : `changed ${ago(actions.serverNow - file.modifiedAt)}`
  const meta = [count, change].filter((piece): piece is string => piece !== null).join(", ")
  const reason = file.state === "unmanaged" ? splitReason(file.reason ?? "") : null

  return (
    <section aria-label={file.name} className="@container/file overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-cell px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2.5 gap-y-1">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="font-mono text-[0.8125rem] font-semibold wrap-anywhere">{file.name}</h3>
          {file.state === "absent" && <Status tone="error">Missing</Status>}
          {file.state === "unmanaged" && <Status tone="attention">Unmanaged</Status>}
          {meta !== "" && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {offer.restore && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions.restore(target)}
              className="text-muted-foreground hover:text-foreground max-md:h-10"
            >
              <Undo2 />
              Restore previous
              {!actions.state.open && <LockGlyph />}
            </Button>
          )}
          {offer.create && (
            <Button variant="outline" size="sm" disabled={actions.creation === key} onClick={() => actions.create(target)} className="max-md:h-10">
              <FilePlus />
              {actions.creation === key ? "Creating…" : "Create file"}
              {!actions.state.open && <LockGlyph />}
            </Button>
          )}
          {offer.add && (
            <Button
              variant="outline"
              size="sm"
              data-add-variable={key}
              data-after-creation={key}
              onClick={() => actions.add(target)}
              className="max-md:h-10"
            >
              <Plus />
              Add variable
              {!actions.state.open && <LockGlyph />}
            </Button>
          )}
        </div>
      </div>

      {file.state === "absent" && (
        <p className="max-w-prose px-4 py-3 text-sm text-pretty text-muted-foreground">
          Not on the server: {slug} starts without it.
        </p>
      )}

      {reason !== null && (
        <div className="grid max-w-2xl gap-2 px-4 pt-3 pb-4">
          <p className="text-sm text-pretty">{reason.text}</p>
          {reason.command !== null && <Command text={reason.command} />}
          <p className="text-xs text-pretty text-muted-foreground">
            Expected: <Terminal>{file.expected}</Terminal>. Fix it on the server, then refresh this page.
          </p>
        </div>
      )}

      {offer.add && file.variables.length === 0 && (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">No variables yet. Add the first one.</p>
      )}

      {offer.add && file.variables.length > 0 && (
        <>
          <VariablesHeader />
          <ul aria-label={`Variables in ${file.name}`} className="divide-y divide-divider @max-xl/file:border-t">
            {file.variables.map((variable) => {
              const variableTarget = { ...target, variable }
              const rowOffer = variableOffer(file, variable)
              if (rowOffer === "password") {
                return <PasswordRow key={variable} name={variable} onChangePassword={actions.person ? null : () => actions.changePassword(variableTarget)} />
              }
              return (
                <VariableRow
                  key={variable}
                  name={variable}
                  unlocked={actions.state.open}
                  read={() => actions.read(variableTarget)}
                  onUnlock={actions.unlock}
                  onEdit={() => actions.edit(variableTarget)}
                  onRemove={() => actions.remove(variableTarget)}
                />
              )
            })}
          </ul>
        </>
      )}

      {error !== "" && (
        <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

// --- What is wrong ---------------------------------------------------------------

/** Names in a sentence, "a, b and c", as typed in a terminal; after `lead` when there is one, in words. */
export function NameList({ names, lead = null }: { names: readonly string[]; lead?: string | null }) {
  const items: { key: string; node: ReactNode }[] = [
    ...(lead === null ? [] : [{ key: " lead", node: lead }]),
    ...names.map((name) => ({ key: name, node: <span className="font-mono">{name}</span> })),
  ]
  return (
    <>
      {items.map((item, index) => (
        <span key={item.key}>
          {index > 0 && (index === items.length - 1 ? " and " : ", ")}
          {item.node}
        </span>
      ))}
    </>
  )
}

/** What is wrong at the project level: its service, and the restart that is pending. The files say the rest. */
export function ProblemRow({ problem, slug }: { problem: Problem; slug: string }) {
  const severity = problem.tone === "error" ? "error" : "warning"
  let text: ReactNode = null
  if (problem.key === "service") {
    const systemd = problem.systemd === null ? "" : ` systemd reports ${problem.systemd}.`
    text =
      problem.label === "Restarting" ? (
        <>
          <strong className="font-medium">{slug} keeps restarting.</strong>
          {systemd} A value it reads at startup may be wrong: check the latest change below and in Activity, or its logs
          with journalctl on the server.
        </>
      ) : problem.label === "Down" ? (
        <>
          <strong className="font-medium">{slug} is down.</strong>
          {systemd} Check its logs with journalctl on the server before restarting it.
        </>
      ) : (
        <>
          <strong className="font-medium">
            {slug} is {problem.label.toLowerCase()}.
          </strong>
          {systemd}
        </>
      )
  } else if (problem.key === "pending") {
    text = (
      <>
        <strong className="font-medium">Restart pending.</strong>{" "}
        <NameList names={problem.files} lead={problem.variables ? "The variables" : null} /> changed since {slug} started.
      </>
    )
  } else if (problem.key === "store-unread") {
    text = (
      <>
        <strong className="font-medium">{slug} does not read its store yet.</strong> What is set here reaches it once it
        is deployed again, or refreshed: <code className="font-mono text-xs whitespace-nowrap">sitesolide refresh {slug}</code>
      </>
    )
  } else {
    return null
  }
  return (
    <li className="flex gap-3 px-4 py-3">
      <SeverityIcon severity={severity} label className="mt-0.5" />
      <p className="min-w-0 flex-1 text-sm text-pretty">{text}</p>
    </li>
  )
}

// --- A site's files --------------------------------------------------------------

/** A panel's line on the project's service: its word, how long it has run, its unit; `none` when it has no service. */
export function ServiceLine({ project, serverNow, none }: { project: ProjectView; serverNow: number; none: string }) {
  if (project.service === null) return <span className="text-sm">{none}</span>
  const service = readService(project.service, serverNow)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="sr-only">Service: </span>
      <Status tone={service.tone}>{service.text}</Status>
      {service.detail !== null && <span className="text-muted-foreground tabular-nums">{service.detail}</span>}
      <code className="font-mono text-xs text-muted-foreground">{project.service.unit}</code>
    </span>
  )
}

/**
 * The platform's own files, on the dashboard's and the portal's sites: the
 * service and its restart, what is wrong, then each file, its actions and its
 * variables. Changing site or section unmounts the
 * rows, and with them any revealed value.
 */
export function FilesPanel({ project }: { project: ProjectView }) {
  const actions = useSecretsActions()
  const problems = projectProblems(project, actions.serverNow).filter(
    (problem) => problem.key === "service" || problem.key === "pending",
  )
  const wait = problems.some((problem) => problem.key === "pending")

  return (
    <Panel
      title="Files"
      count={project.files.length}
      full
      description={<ServiceLine project={project} serverNow={actions.serverNow} none="No service: nothing reads these files at startup." />}
      actions={
        project.service === null ? undefined : (
          <Button variant={wait ? "default" : "outline"} size="sm" onClick={() => actions.restart(project.slug)} className="max-md:h-10">
            <RotateCcw />
            Restart service
            {!actions.state.open && !actions.person && <LockGlyph />}
          </Button>
        )
      }
    >
      {problems.length > 0 && (
        <ul aria-label={`What needs attention in ${project.slug}`} className="divide-y divide-divider border-b">
          {problems.map((problem) => (
            <ProblemRow key={problem.key} problem={problem} slug={project.slug} />
          ))}
        </ul>
      )}

      {project.files.length === 0 ? (
        <EmptyState icon={FileText} title="No secret files" compact />
      ) : (
        <div className="grid gap-3 p-3">
          {project.files.map((file) => (
            <FileBlock key={file.name} slug={project.slug} file={file} />
          ))}
        </div>
      )}
    </Panel>
  )
}
