import { type ReactNode } from "react"
import { FilePlus, FileText, Pencil, Plus, RectangleEllipsis, RotateCcw, Trash2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Command } from "@/components/copy"
import { CellText, DataTable, RowMenu, gutterFor, type Column } from "@/components/data-table"
import { Banner, Panel, StateLabel, Status } from "@/components/page"
import { fileKey, useSecretsActions, type FileTarget } from "@/components/secrets-actions"
import { LockGlyph } from "@/components/unlock"
import { ON_HOVER, RevealButtons, RevealMenuItems, ValueCell, useValueTable, type ValueTable } from "@/components/secrets-variables"
import { ago, capitalise } from "@/lib/format"
import { PENDING_LABEL, splitReason, fileOffer, variableOffer, projectProblems, fileSummary, type Problem } from "@/lib/secrets"
import type { FileView, ProjectView } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

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

/** "The variables and registry.json changed since cms last started.": the pending restart's pill says it in its tooltip. */
export function pendingSentence(problem: Problem, slug: string): string {
  if (problem.key !== "pending") return ""
  const pieces = [...(problem.variables ? ["The variables"] : []), ...problem.files]
  const names = pieces.length <= 1 ? pieces.join("") : `${pieces.slice(0, -1).join(", ")} and ${pieces[pieces.length - 1]}`
  return `${capitalise(names)} changed since ${slug} last started. A restart applies them.`
}

/**
 * What is wrong with the project as a whole, above its secrets: its service
 * down or restarting, a store its unit does not read yet. The restart that is
 * pending is the panel's pill, and what is not set its rows.
 */
export function ProblemBanner({ problem, slug }: { problem: Problem; slug: string }) {
  if (problem.key === "service") {
    const systemd = problem.systemd === null ? "" : ` systemd reports ${problem.systemd}.`
    const tone = problem.tone === "error" ? "error" : "attention"
    return (
      <Banner tone={tone}>
        {problem.label === "Restarting" ? (
          <>
            <strong className="font-medium">{slug} keeps restarting.</strong>
            {systemd} A value it reads at startup may be wrong: check the latest change in History, or its logs with journalctl on
            the server.
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
        )}
      </Banner>
    )
  }
  if (problem.key === "store-unread") {
    return (
      <Banner tone="attention">
        <strong className="font-medium">{slug} does not read its store yet.</strong> What is set here reaches it once it is
        deployed again, or refreshed: <code className="font-mono text-xs whitespace-nowrap">sitesolide refresh {slug}</code>
      </Banner>
    )
  }
  return null
}

// --- A site's files --------------------------------------------------------------

/**
 * A line of the platform's files: a file, under which come its variables, or
 * what it says instead of them, missing or unmanaged.
 */
type FileLine =
  | { kind: "file"; file: FileView }
  | { kind: "variable"; file: FileView; name: string }
  | { kind: "note"; file: FileView }

function linesOf(files: readonly FileView[]): FileLine[] {
  return files.flatMap((file): FileLine[] => {
    if (file.state === "managed") return [{ kind: "file", file }, ...file.variables.map((name): FileLine => ({ kind: "variable", file, name }))]
    return [{ kind: "file", file }, { kind: "note", file }]
  })
}

const lineKey = (line: FileLine) => (line.kind === "file" ? line.file.name : line.kind === "note" ? `${line.file.name} note` : `${line.file.name}/${line.name}`)

/** Hidden in a narrow list, where the row menu holds the same action. */
const WIDE_ONLY = "@max-xl/table:hidden"

/**
 * The platform's own files, on the dashboard's and the portal's sites: one
 * list, each file a heading line with its actions and its variables under
 * it, one line each. The restart is prominent while one is pending, in the
 * panel's menu otherwise. Changing site or section unmounts the rows, and
 * with them any revealed value.
 */
export function FilesPanel({ project }: { project: ProjectView }) {
  const actions = useSecretsActions()
  const slug = project.slug
  const locked = !actions.state.open
  const problems = projectProblems(project, actions.serverNow)
  const service = problems.filter((problem) => problem.key === "service")
  const pending = problems.find((problem) => problem.key === "pending") ?? null
  const restartable = project.service !== null
  const restartLocked = locked && !actions.person
  const values: ValueTable = useValueTable(
    actions.state.open,
    (key) => {
      const [file, ...rest] = key.split("/")
      return actions.read({ slug, file: file ?? "", variable: rest.join("/") })
    },
    (purpose) => actions.unlock({ purpose }),
  )
  const lines = linesOf(project.files)

  const severity = (line: FileLine): Severity | null =>
    line.kind !== "file" ? null : line.file.state === "absent" ? "error" : line.file.state === "unmanaged" ? "warning" : null

  const columns: Column<FileLine>[] = [
    {
      key: "name",
      head: "Name",
      width: "minmax(13rem,20rem)",
      slot: "primary",
      cell: (line) => {
        if (line.kind === "file") {
          return (
            <>
              <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <CellText title={line.file.name} className="font-mono text-[0.8125rem] font-semibold text-strong">
                {line.file.name}
              </CellText>
              {line.file.state === "absent" && (
                <StateLabel tone="error" className="shrink-0">
                  Missing
                </StateLabel>
              )}
              {line.file.state === "unmanaged" && (
                <StateLabel tone="attention" className="shrink-0">
                  Unmanaged
                </StateLabel>
              )}
            </>
          )
        }
        if (line.kind === "note") return null
        return (
          <CellText title={line.name} className="pl-6 font-mono text-[0.8125rem]">
            {line.name}
          </CellText>
        )
      },
    },
    {
      key: "value",
      head: "Value",
      width: "minmax(0,1fr)",
      slot: "meta",
      cell: (line) => {
        if (line.kind === "file") {
          const count = fileSummary(line.file)
          const change = line.file.modifiedAt === null ? null : `changed ${ago(actions.serverNow - line.file.modifiedAt)}`
          const meta = [count, change].filter((piece): piece is string => piece !== null).join(", ")
          return meta === "" ? null : <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>
        }
        if (line.kind === "note") {
          if (line.file.state === "absent") return <span className="py-2 text-sm text-pretty text-muted-foreground">Not on the server: {slug} starts without it.</span>
          const reason = splitReason(line.file.reason ?? "")
          return (
            <span className="grid min-w-0 gap-2 py-2">
              <span className="text-sm text-pretty">{reason.text}</span>
              {reason.command !== null && <Command text={reason.command} />}
              <span className="text-xs text-pretty text-muted-foreground">
                Expected: <code className="font-mono">{line.file.expected}</code>. Fix it on the server, then refresh this page.
              </span>
            </span>
          )
        }
        if (variableOffer(line.file, line.name) === "password") {
          return (
            <span className="text-xs text-pretty text-muted-foreground">
              {actions.person ? "A password hash. It never shows, and only the owner changes it." : "A password hash. It never shows: change the password instead."}
            </span>
          )
        }
        return <ValueCell table={values} rowKey={lineKey(line)} />
      },
    },
    {
      key: "actions",
      head: "",
      srHead: "Actions",
      width: "13rem",
      align: "end",
      slot: "state",
      cell: (line) => {
        const target: FileTarget = { slug, file: line.file.name }
        const key = fileKey(target)
        if (line.kind === "file") {
          const offer = fileOffer(line.file)
          return (
            <>
              {offer.create && (
                <Button variant="outline" size="sm" disabled={actions.creation === key} onClick={() => actions.create(target)} className="max-md:h-10">
                  <FilePlus />
                  {actions.creation === key ? "Creating…" : "Create file"}
                  {locked && <LockGlyph />}
                </Button>
              )}
              {offer.add && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-add-variable={key}
                  data-after-creation={key}
                  onClick={() => actions.add(target)}
                  className={cn("text-muted-foreground hover:text-foreground", ON_HOVER, WIDE_ONLY)}
                >
                  <Plus />
                  Add variable
                  {locked && <LockGlyph />}
                </Button>
              )}
            </>
          )
        }
        if (line.kind === "note") return null
        const variable = { ...target, variable: line.name }
        if (variableOffer(line.file, line.name) === "password") {
          if (actions.person) return null
          return (
            <Button variant="outline" size="sm" data-password-variable={line.name} onClick={() => actions.changePassword(variable)} className={cn("max-md:h-10", WIDE_ONLY)}>
              <RectangleEllipsis />
              Change password
              {locked && <LockGlyph />}
            </Button>
          )
        }
        return (
          <span className={cn("flex items-center gap-0.5", WIDE_ONLY)}>
            <RevealButtons table={values} rowKey={lineKey(line)} name={line.name} />
            <Button
              variant="ghost"
              size="sm"
              disabled={values.busy}
              onClick={() => actions.edit(variable)}
              aria-label={`Change ${line.name}`}
              className={cn("text-muted-foreground hover:text-foreground", ON_HOVER)}
            >
              <Pencil />
              Change
              {locked && <LockGlyph />}
            </Button>
          </span>
        )
      },
    },
  ]

  const menu = (line: FileLine) => {
    const target: FileTarget = { slug, file: line.file.name }
    if (line.kind === "note") return null
    if (line.kind === "file") {
      const offer = fileOffer(line.file)
      if (!offer.add && !offer.restore) return null
      return (
        <RowMenu label={`Actions for ${line.file.name}`}>
          {offer.add && (
            <DropdownMenuItem onClick={() => actions.add(target)} className="h-9">
              <Plus />
              Add variable
              {locked && <LockGlyph className="ml-auto" />}
            </DropdownMenuItem>
          )}
          {offer.restore && (
            <DropdownMenuItem onClick={() => actions.restore(target)} className="h-9">
              <Undo2 />
              Restore previous version
              {locked && <LockGlyph className="ml-auto" />}
            </DropdownMenuItem>
          )}
        </RowMenu>
      )
    }
    const variable = { ...target, variable: line.name }
    if (variableOffer(line.file, line.name) === "password") {
      if (actions.person) return null
      return (
        <RowMenu label={`Actions for ${line.name}`}>
          <DropdownMenuItem onClick={() => actions.changePassword(variable)} className="h-9">
            <RectangleEllipsis />
            Change password
            {locked && <LockGlyph className="ml-auto" />}
          </DropdownMenuItem>
        </RowMenu>
      )
    }
    return (
      <RowMenu label={`Actions for ${line.name}`}>
        <RevealMenuItems table={values} rowKey={lineKey(line)} name={line.name} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => actions.edit(variable)} className="h-9">
          <Pencil />
          Change value
          {locked && <LockGlyph className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => actions.remove(variable)} className="h-9">
          <Trash2 />
          Remove variable
          {locked && <LockGlyph className="ml-auto" />}
        </DropdownMenuItem>
      </RowMenu>
    )
  }

  const errors = project.files
    .map((file) => ({ file: file.name, error: actions.errors[fileKey({ slug, file: file.name })] ?? "" }))
    .filter((entry) => entry.error !== "")

  return (
    <>
      {service.map((problem) => (
        <ProblemBanner key={problem.key} problem={problem} slug={slug} />
      ))}
      <Panel
        title="Files"
        count={project.files.length}
        full
        actions={
          restartable ? (
            pending !== null ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Status tone="attention" shape="pill" title={pendingSentence(pending, slug)}>
                  {PENDING_LABEL}
                </Status>
                <Button size="sm" onClick={() => actions.restart(slug)} className="max-md:h-10">
                  <RotateCcw />
                  Restart service
                  {restartLocked && <LockGlyph />}
                </Button>
              </div>
            ) : (
              <RowMenu label={`More actions for ${slug}`} className="size-8">
                <DropdownMenuItem onClick={() => actions.restart(slug)} className="h-9">
                  <RotateCcw />
                  Restart service
                  {restartLocked && <LockGlyph className="ml-auto" />}
                </DropdownMenuItem>
              </RowMenu>
            )
          ) : undefined
        }
      >
        <DataTable
          label={`Files of ${slug}`}
          caption="Each file, then its variables"
          narrowBelow="36rem"
          rows={lines}
          rowKey={lineKey}
          columns={columns}
          severity={gutterFor(lines, severity)}
          menu={menu}
        />
        {errors.map((entry) => (
          <p key={entry.file} role="alert" className="border-t px-4 py-3 text-sm text-destructive">
            <span className="font-mono">{entry.file}</span>: {entry.error}
          </p>
        ))}
      </Panel>
    </>
  )
}
