import { type ReactNode } from "react"
import { FileKey, FilePen, FilePlus, FileText, Lock, LockOpen, Plus, RotateCcw, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command } from "@/components/copy"
import { EmptyState, SeverityIcon, Panel, Status } from "@/components/page"
import { ContentReveal } from "@/components/secrets-content"
import { fileKey, useSecretsActions, type FileTarget } from "@/components/secrets-actions"
import { VariablesHeader, PasswordRow, VariableRow } from "@/components/secrets-variables"
import { ago } from "@/lib/format"
import {
  filePath,
  splitReason,
  readService,
  fileOffer,
  variableOffer,
  projectProblems,
  fileSummary,
  type Problem,
} from "@/lib/secrets"
import { TONE_PILL } from "@/lib/tones"
import type { FileView, ProjectView } from "@/lib/types"
import { cn } from "@/lib/utils"

// --- The lock, in the page header ------------------------------------------------

/**
 * The lock's state and its button, among the header's actions: visible from the
 * whole page, since the header stays at the top. Unlocked, the pill turns to
 * warning: the values are one click away.
 */
export function SecretsLockControl() {
  const { state, locking, lockButtonRef, unlock, lock } = useSecretsActions()
  const Icon = state.open ? LockOpen : Lock
  return (
    <>
      <span
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium whitespace-nowrap tabular-nums",
          TONE_PILL[state.open ? "attention" : "neutral"],
        )}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {state.label}
      </span>
      {/* One single button, whose label changes: focus stays on it from one state to the next. */}
      <Button
        ref={lockButtonRef}
        variant={state.open ? "outline" : "default"}
        disabled={locking}
        onClick={state.open ? lock : unlock}
        className="max-md:h-10 max-md:px-3.5"
      >
        {state.open ? <Lock /> : <LockOpen />}
        {state.open ? (locking ? "Locking…" : "Lock") : "Unlock"}
      </Button>
    </>
  )
}

// --- A file ----------------------------------------------------------------------

/** A file's path under /etc/sitesolide, its folder set back: `<slug>-secrets/` then `token`. */
function FileName({ name }: { name: string }) {
  const { folder, base } = filePath(name)
  return (
    <h3 className="font-mono text-[0.8125rem] font-semibold wrap-anywhere">
      {folder !== null && <span className="font-normal text-muted-foreground">{folder}</span>}
      {base}
    </h3>
  )
}

function Terminal({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs whitespace-nowrap">{children}</code>
}

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
  const Icon = file.kind === "content" ? FileKey : FileText

  return (
    <section aria-label={file.name} className="@container/file border-t first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2.5 gap-y-1">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <FileName name={file.name} />
          {file.state === "absent" && <Status tone="error">Missing</Status>}
          {file.state === "unmanaged" && <Status tone="attention">Unmanaged</Status>}
          {offer.writeOnly && (
            <Status tone="neutral" title="Replaced, never read back" className="text-muted-foreground">
              Write-only
            </Status>
          )}
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
            </Button>
          )}
          {offer.create && (
            <Button variant="outline" size="sm" disabled={actions.creation === key} onClick={() => actions.create(target)} className="max-md:h-10">
              <FilePlus />
              {actions.creation === key ? "Creating…" : "Create file"}
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
            </Button>
          )}
          {offer.replace && (
            <Button variant="outline" size="sm" data-after-creation={key} onClick={() => actions.replace(target)} className="max-md:h-10">
              <FilePen />
              Replace
            </Button>
          )}
        </div>
      </div>

      {file.state === "absent" && (
        <p className="max-w-prose px-4 pb-3 text-sm text-pretty text-muted-foreground">
          Declared for {slug}, but not on the server, so {slug} starts without it. Create file makes it empty, owned by{" "}
          <Terminal>{file.expected}</Terminal>
          {file.kind === "content" ? ", then Replace fills it." : ", then add its variables."}
        </p>
      )}

      {reason !== null && (
        <div className="grid max-w-2xl gap-2 px-4 pb-4">
          <p className="text-sm text-pretty">{reason.text}</p>
          {reason.command !== null && <Command text={reason.command} />}
          <p className="text-xs text-pretty text-muted-foreground">
            The steward expects <Terminal>{file.expected}</Terminal>. It lists this file but never rewrites it: fix
            it on the server, then refresh this page.
          </p>
        </div>
      )}

      {file.state === "managed" && file.kind === "content" && !file.readable && (
        <p className="max-w-prose px-4 pb-3 text-sm text-pretty text-muted-foreground">
          The steward replaces this file but never reads it back, so its content can't be shown or copied, not even
          here. Keep the original where you made it.
        </p>
      )}

      {offer.reveal && (
        <ContentReveal
          file={file.name}
          unlocked={actions.state.open}
          read={() => actions.readContent(target)}
          onUnlock={actions.unlock}
        />
      )}

      {offer.add && file.variables.length === 0 && (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">No variables yet. Add the first one.</p>
      )}

      {offer.add && file.variables.length > 0 && (
        <>
          <VariablesHeader />
          <ul aria-label={`Variables in ${file.name}`} className="divide-y @max-xl/file:border-t">
            {file.variables.map((variable) => {
              const variableTarget = { ...target, variable }
              const rowOffer = variableOffer(file, variable)
              if (rowOffer === "password") {
                return <PasswordRow key={variable} name={variable} onChangePassword={() => actions.changePassword(variableTarget)} />
              }
              return (
                <VariableRow
                  key={variable}
                  name={variable}
                  readable={rowOffer === "read-write"}
                  unlocked={actions.state.open}
                  read={() => actions.read(variableTarget)}
                  onUnlock={actions.unlock}
                  onEdit={() => actions.modifier(variableTarget)}
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

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>
}

function ListState({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && (index === names.length - 1 ? " and " : ", ")}
          <Mono>{name}</Mono>
        </span>
      ))}
    </>
  )
}

/** What is wrong at the project level: its service, and the restart that is pending. The files say the rest. */
function ProblemRow({ problem, slug }: { problem: Problem; slug: string }) {
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
        <strong className="font-medium">Restart pending.</strong> <ListState names={problem.files} /> changed after {slug} last
        started, so it still runs with the old values.
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

/**
 * A site's secret files: its service and its restart, what is wrong, then each
 * file, its actions and its variables. Changing site or section unmounts the
 * rows, and with them any revealed value.
 */
export function FilesPanel({ project }: { project: ProjectView }) {
  const actions = useSecretsActions()
  const service = project.service === null ? null : readService(project.service, actions.serverNow)
  const problems = projectProblems(project, actions.serverNow).filter(
    (problem) => problem.key === "service" || problem.key === "pending",
  )
  const wait = problems.some((problem) => problem.key === "pending")

  return (
    <Panel
      title="Files"
      count={project.files.length}
      full
      description={
        project.service === null || service === null ? (
          <span className="text-sm">No service: nothing reads these files at startup.</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="sr-only">Service: </span>
            <Status tone={service.tone}>{service.text}</Status>
            {service.detail !== null && <span className="text-muted-foreground tabular-nums">{service.detail}</span>}
            <code className="font-mono text-xs text-muted-foreground">{project.service.unit}</code>
          </span>
        )
      }
      actions={
        project.service === null ? undefined : (
          <Button variant={wait ? "default" : "outline"} size="sm" onClick={() => actions.restart(project.slug)} className="max-md:h-10">
            <RotateCcw />
            Restart service
          </Button>
        )
      }
    >
      {problems.length > 0 && (
        <ul aria-label={`What needs attention in ${project.slug}`} className="divide-y border-b">
          {problems.map((problem) => (
            <ProblemRow key={problem.key} problem={problem} slug={project.slug} />
          ))}
        </ul>
      )}

      {project.files.length === 0 ? (
        <EmptyState icon={FileText} title="No secret files" compact />
      ) : (
        project.files.map((file) => <FileBlock key={file.name} slug={project.slug} file={file} />)
      )}
    </Panel>
  )
}
