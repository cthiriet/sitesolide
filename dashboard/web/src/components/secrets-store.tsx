import { useRef, useState, type ReactNode } from "react"
import { Check, ChevronRight, Copy, Dices, FileUp, Pencil, Plus, RotateCcw, Trash2, Undo2, Variable } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Command, CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { CellText, DataTable, RowMenu, type Column } from "@/components/data-table"
import { Banner, InlineEmpty, Panel, StateLabel, Status } from "@/components/page"
import { ProblemBanner, pendingSentence } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { LockGlyph, useWrite } from "@/components/unlock"
import { ConfirmDialog, useOrigin } from "@/components/secrets-dialogs"
import {
  StoreFileDialog,
  StoreRestoreDialog,
  StoreValueDialog,
  type FileTarget,
  type RestoreTarget,
  type ValueTarget,
} from "@/components/secrets-store-dialogs"
import { ON_HOVER, RevealButtons, RevealMenuItems, ValueCell, useValueTable, type ReadResult } from "@/components/secrets-variables"
import { removeStoreFile, removeStoreVariables, revealStoreValue } from "@/lib/api"
import { ago, size } from "@/lib/format"
import { PENDING_LABEL, projectProblems, refusalOf, splitReason, succeeded } from "@/lib/secrets"
import {
  changeSummary,
  credentialPath,
  isEmptyFile,
  storeFileOffer,
  storeFileState,
  storeVariableOffer,
  UNDECLARED,
  UNDECLARED_HINT,
} from "@/lib/store"
import type { ProjectView, StoreChangeResponse, StoreFileView, StoreView } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/verdict"

/*
 * A project's store, on its Secrets page: one panel of variables, the names
 * sitesolide.json declares and the server lacks first, in red, with *Set*
 * and *Generate* in their row; then every name the store holds, one line
 * each, whose *Reveal*, *Copy* and *Set* come under the pointer and whose
 * other writes are in the row menu. One *Add* in the panel's header. The
 * files, when there are any, in a panel of their own; the build's names and
 * the public values in a closed disclosure. Every write goes to the steward,
 * which judges; a value is typed into a dialog and leaves with the request,
 * and only the owner's unlocked dashboard ever reads one back, for thirty
 * seconds.
 */

/** A name from sitesolide.json in a sentence, as it is written there. */
export function Code({ children }: { children: string }) {
  return <code className="rounded-sm border bg-cell px-1 py-px font-mono text-xs whitespace-nowrap">{children}</code>
}

type Confirm = { kind: "variable" | "file"; slug: string; name: string; open: boolean }

/** A row of the variables: a name the store holds, or one sitesolide.json declares and the server lacks. */
type VariableLine = { name: string; missing: boolean; declared: boolean }

/** Hidden in a narrow list, where the row menu holds the same action. */
const WIDE_ONLY = "@max-xl/table:hidden"

/** A row menu's write: the lock glyph at its end while changes are locked; the action asks for the unlock itself. */
function WriteItem({
  onClick,
  locked,
  destructive = false,
  children,
}: {
  onClick: () => void
  locked: boolean
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <DropdownMenuItem variant={destructive ? "destructive" : "default"} onClick={onClick} className="h-9">
      {children}
      {locked && <LockGlyph className="ml-auto" />}
    </DropdownMenuItem>
  )
}

/** An item of the *Add* menu: what it adds, and how, in one line under it. */
function AddItem({ icon: Icon, title, detail, onClick }: { icon: typeof Plus; title: string; detail: string; onClick: () => void }) {
  return (
    <DropdownMenuItem onClick={onClick} className="items-start py-2">
      <Icon className="mt-0.5" />
      <span className="grid gap-0.5">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </DropdownMenuItem>
  )
}

// --- A file's path -----------------------------------------------------------------

/** The path a service reads a file at, to copy into its code as it stands; its copy button under the pointer. */
function CredentialPath({ name }: { name: string }) {
  const path = credentialPath(name)
  const { state, copy, reset } = useCopy("Path copied")
  if (state === "failure") return <CopyFallback text={path} onClose={reset} />
  return (
    <>
      <CellText title={path} className="font-mono text-xs text-secondary-foreground">
        {path}
      </CellText>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy the path of ${name}`}
        title="Copy path"
        onClick={() => void copy(path)}
        className={cn("shrink-0 text-muted-foreground hover:text-foreground", state !== "copied" && ON_HOVER, WIDE_ONLY)}
      >
        {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
      </Button>
    </>
  )
}

// --- The build's names and the public values ---------------------------------------

/**
 * What the store does not hold but the project reads, for reference and with
 * no action: the build's names, kept by whoever deploys, and the public
 * values from sitesolide.json. Closed, its count in its summary, so that
 * folding them costs no trust.
 */
function OtherNames({ slug, store }: { slug: string; store: StoreView }) {
  const count = store.build.length + store.public.length
  if (count === 0) return null
  const title = store.build.length === 0 ? "Public names" : store.public.length === 0 ? "Build names" : "Build and public names"
  return (
    <details className="group border-t">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-sm text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {title} ({count})
      </summary>
      <div className="grid gap-5 pr-4 pb-4 pl-10">
        {store.build.length > 0 && (
          <section aria-label={`Build secrets of ${slug}`} className="grid gap-2">
            <h3 className="mono-label">Build, kept by whoever deploys</h3>
            <ul className="grid gap-1">
              {store.build.map((name) => (
                <li key={name}>
                  <code className="font-mono text-[0.8125rem] wrap-anywhere">{name}</code>
                </li>
              ))}
            </ul>
            <p className="text-xs text-pretty text-muted-foreground">
              Read where you deploy, from the environment or{" "}
              <code className="font-mono wrap-anywhere">~/.config/sitesolide/secrets/{slug}.env</code>. Never on the server.
            </p>
          </section>
        )}
        {store.public.length > 0 && (
          <section aria-label={`Public variables of ${slug}`} className="grid gap-2">
            <h3 className="mono-label">Public, from the repository</h3>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
              {store.public.map((entry) => (
                <div key={entry.name} className="grid gap-0.5 sm:col-span-2 sm:grid-cols-subgrid">
                  <dt className="font-mono text-[0.8125rem] wrap-anywhere">{entry.name}</dt>
                  <dd className="min-w-0 font-mono text-xs break-all text-secondary-foreground">{entry.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-pretty text-muted-foreground">
              From <Code>env</Code> in <Code>sitesolide.json</Code>: change them there, then deploy.
            </p>
          </section>
        )}
      </div>
    </details>
  )
}

// --- The section -------------------------------------------------------------------

/**
 * A project's store and what goes with it, on its Secrets page. The rows and
 * dialogs unmount with the project: no value revealed or typed carries over to
 * another one.
 */
export function StoreSection({ project, store }: { project: ProjectView; store: StoreView }) {
  const actions = useSecretsActions()
  const announce = useAnnounce()
  const { locked } = useWrite()
  const { remember, focusReturn } = useOrigin()
  const slug = project.slug
  const restartable = project.service !== null
  const openings = useRef(0)
  const [value, setValue] = useState<(ValueTarget & { open: boolean }) | null>(null)
  const [file, setFile] = useState<(FileTarget & { open: boolean }) | null>(null)
  const [restore, setRestore] = useState<(RestoreTarget & { open: boolean }) | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState("")

  const write = store.may.write && store.state !== "unmanaged"
  const problems = projectProblems(project, actions.serverNow)
  const banners = problems.filter((problem) => problem.key === "service" || problem.key === "store-unread")
  const pending = problems.find((problem) => problem.key === "pending") ?? null
  const byName = new Map(store.variables.map((variable) => [variable.name, variable]))
  const values = useValueTable(actions.state.open, (name) => read(name), (purpose) => actions.unlock({ purpose }))

  // The declared names the server lacks first, then every name the store holds, in the steward's order.
  const lines: VariableLine[] = [
    ...store.missing.map((name) => ({ name, missing: true, declared: true })),
    ...store.variables.filter((variable) => variable.source !== "none").map((variable) => ({ name: variable.name, missing: false, declared: variable.declared })),
  ]
  // A declared file the server lacks first, in red, then the others.
  const files = [...store.files].sort((a, b) => Number(b.state === "missing" && b.declared) - Number(a.state === "missing" && a.declared))
  const unmanagedFiles = store.files.filter((one) => one.state === "unmanaged" && one.reason !== null)

  /** A new number per opening, read when the dialog opens, which may be after an unlock: never a stale one. */
  function next(): number {
    openings.current += 1
    return openings.current
  }

  /** An action that writes: remembered where it started, asked for the unlock first when locked. */
  function writing(open: () => void, purpose: string, resume: string) {
    remember()
    actions.require(open, { purpose, resume })
  }

  function openValue(name: string | null, mode: "type" | "generate") {
    const replaces = name !== null && (byName.get(name)?.source ?? "none") !== "none"
    const purpose = name === null ? (mode === "generate" ? "generate a value" : "add a variable") : `${mode === "generate" ? (replaces ? "replace" : "generate") : "set"} ${name}`
    writing(() => setValue({ slug, name, mode, replaces, opening: next(), open: true }), purpose, mode === "generate" ? (replaces ? "Replace" : "Generate") : name === null ? "Add" : "Set")
  }

  function openFile(name: string | null) {
    const replaces = name !== null && store.files.some((one) => one.name === name && (one.state === "set" || isEmptyFile(one)))
    writing(
      () => setFile({ slug, name, replaces, opening: next(), open: true }),
      name === null ? "upload a file" : `${replaces ? "replace" : "upload"} ${name}`,
      name === null ? "Add" : replaces ? "Replace" : "Upload",
    )
  }

  function askConfirm(target: Confirm) {
    writing(
      () => {
        setConfirmError("")
        setConfirm(target)
      },
      `remove ${target.name}`,
      "Remove",
    )
  }

  function done(answer: StoreChangeResponse, restart: boolean, close: () => void) {
    close()
    announce(changeSummary(answer, slug))
    actions.changed()
    if (restart) actions.restartNow(slug)
  }

  async function read(name: string): Promise<ReadResult> {
    const { status, body } = await revealStoreValue({ slug, name })
    if (succeeded(status) && body !== null && typeof body.value === "string") {
      // A reveal is journaled: Activity shows it.
      actions.changed()
      return { value: body.value }
    }
    return { message: actions.refusal(refusalOf(status, body)) }
  }

  async function confirmAction() {
    if (confirm === null || confirming) return
    setConfirming(true)
    setConfirmError("")
    try {
      const { status, body } =
        confirm.kind === "variable"
          ? await removeStoreVariables({ slug, names: [confirm.name] })
          : await removeStoreFile({ slug, name: confirm.name })
      if (succeeded(status) && body !== null) {
        setConfirm({ ...confirm, open: false })
        announce(changeSummary(body, slug))
        return actions.changed()
      }
      const message = actions.refusal(refusalOf(status, body))
      if (message !== null) setConfirmError(message)
    } finally {
      setConfirming(false)
    }
  }

  const unmanaged = store.state === "unmanaged" ? splitReason(store.reason ?? "The server does not manage this store.") : null
  const nothing = lines.length === 0 && store.files.length === 0
  // The owner restarts from an unlock; a person with their session alone.
  const restartLocked = locked && !actions.person
  const restorable = store.previous && store.may.restore
  const quietRestart = restartable && pending === null

  // --- The variables' columns

  const variableColumns: Column<VariableLine>[] = [
    {
      key: "name",
      head: "Name",
      width: "minmax(12rem,18rem)",
      slot: "primary",
      cell: (line) => (
        <CellText title={line.name} className="font-mono text-[0.8125rem] text-strong">
          {line.name}
        </CellText>
      ),
    },
    {
      key: "value",
      head: "Value",
      width: "minmax(0,1fr)",
      slot: "meta",
      cell: (line) => (
        <ValueCell
          table={values}
          rowKey={line.name}
          idle={
            line.missing ? (
              <StateLabel tone="error" title={`${slug} starts without it`}>
                Not set
              </StateLabel>
            ) : !line.declared ? (
              <StateLabel tone="neutral" title={UNDECLARED_HINT}>
                {UNDECLARED}
              </StateLabel>
            ) : null
          }
        />
      ),
    },
    {
      key: "actions",
      head: "",
      srHead: "Actions",
      width: "13rem",
      align: "end",
      slot: "state",
      cell: (line) => {
        const offer = storeVariableOffer(store, { source: line.missing ? "none" : "store" })
        if (line.missing) {
          if (!write) return null
          return (
            <>
              <Button variant="outline" size="sm" onClick={() => openValue(line.name, "type")} aria-label={`Set ${line.name}`} className="max-md:h-10">
                <Pencil />
                Set
                {locked && <LockGlyph />}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openValue(line.name, "generate")} aria-label={`Generate ${line.name}`} className={cn("max-md:h-10", WIDE_ONLY)}>
                <Dices />
                Generate
                {locked && <LockGlyph />}
              </Button>
            </>
          )
        }
        return (
          <span className={cn("flex items-center gap-0.5", WIDE_ONLY)}>
            {offer.reveal && <RevealButtons table={values} rowKey={line.name} name={line.name} />}
            {offer.set && (
              <Button
                variant="ghost"
                size="sm"
                disabled={values.busy}
                onClick={() => openValue(line.name, "type")}
                aria-label={`Set ${line.name}`}
                className={cn("text-muted-foreground hover:text-foreground", ON_HOVER)}
              >
                <Pencil />
                Set
                {locked && <LockGlyph />}
              </Button>
            )}
          </span>
        )
      },
    },
  ]

  const variableMenu = (line: VariableLine) => {
    const offer = storeVariableOffer(store, { source: line.missing ? "none" : "store" })
    if (!offer.reveal && !offer.set && !offer.remove) return null
    return (
      <RowMenu label={`Actions for ${line.name}`}>
        {offer.reveal && (
          <>
            <RevealMenuItems table={values} rowKey={line.name} name={line.name} />
            {offer.set && <DropdownMenuSeparator />}
          </>
        )}
        {offer.set && (
          <WriteItem onClick={() => openValue(line.name, "type")} locked={locked}>
            <Pencil />
            {line.missing ? "Type a value" : "Type a new value"}
          </WriteItem>
        )}
        {offer.generate && (
          <WriteItem onClick={() => openValue(line.name, "generate")} locked={locked}>
            <Dices />
            {offer.replaces ? "Generate a new value" : "Generate a value"}
          </WriteItem>
        )}
        {offer.remove && (
          <>
            <DropdownMenuSeparator />
            <WriteItem onClick={() => askConfirm({ kind: "variable", slug, name: line.name, open: true })} locked={locked} destructive>
              <Trash2 />
              Remove variable
            </WriteItem>
          </>
        )}
      </RowMenu>
    )
  }

  // --- The files' columns

  const sizes = files.some((one) => one.bytes !== null)
  const fileSeverity = (one: StoreFileView): Severity | null => {
    const state = storeFileState(one)
    return state === null ? null : state.tone === "error" ? "error" : "warning"
  }
  const fileColumns: Column<StoreFileView>[] = [
    {
      key: "name",
      head: "Name",
      width: "minmax(12rem,18rem)",
      slot: "primary",
      cell: (one) => {
        const state = storeFileState(one)
        return (
          <>
            <CellText title={one.name} className="font-mono text-[0.8125rem] text-strong">
              {one.name}
            </CellText>
            {state !== null && (
              <StateLabel tone={state.tone} className="shrink-0">
                {state.text}
              </StateLabel>
            )}
            {!one.declared && (
              <StateLabel tone="neutral" title={UNDECLARED_HINT} className="shrink-0">
                {UNDECLARED}
              </StateLabel>
            )}
          </>
        )
      },
    },
    {
      key: "path",
      head: "Read at",
      width: "minmax(0,1fr)",
      slot: "meta",
      cell: (one) => <CredentialPath name={one.name} />,
    },
    ...(sizes
      ? [
          {
            key: "size",
            head: "Size",
            width: "6rem",
            align: "end",
            slot: "time",
            cell: (one: StoreFileView) =>
              one.bytes === null ? null : (
                <span title={one.modifiedAt === null ? undefined : `Changed ${ago(actions.serverNow - one.modifiedAt)}`} className="tabular-nums">
                  {one.bytes === 0 ? "Empty" : size(one.bytes)}
                </span>
              ),
          } satisfies Column<StoreFileView>,
        ]
      : []),
    {
      key: "upload",
      head: "",
      srHead: "Actions",
      width: "7.5rem",
      align: "end",
      slot: "state",
      cell: (one) => {
        const offer = storeFileOffer(store, one)
        if (!offer.upload) return null
        const present = one.state === "set" || isEmptyFile(one)
        return (
          <Button
            variant={present ? "ghost" : "outline"}
            size="sm"
            onClick={() => openFile(one.name)}
            aria-label={`${present ? "Replace" : "Upload"} ${one.name}`}
            className={cn("max-md:h-10", present && cn("text-muted-foreground hover:text-foreground", ON_HOVER, WIDE_ONLY))}
          >
            <FileUp />
            {present ? "Replace" : "Upload"}
            {locked && <LockGlyph />}
          </Button>
        )
      },
    },
  ]

  const fileMenu = (one: StoreFileView) => {
    const offer = storeFileOffer(store, one)
    const present = one.state === "set" || isEmptyFile(one)
    return (
      <RowMenu label={`Actions for ${one.name}`}>
        <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(credentialPath(one.name)).then(() => announce("Path copied"), () => {})} className="h-9">
          <Copy />
          Copy path
        </DropdownMenuItem>
        {offer.upload && (
          <WriteItem onClick={() => openFile(one.name)} locked={locked}>
            <FileUp />
            {present ? "Replace" : "Upload"}
          </WriteItem>
        )}
        {offer.remove && (
          <>
            <DropdownMenuSeparator />
            <WriteItem onClick={() => askConfirm({ kind: "file", slug, name: one.name, open: true })} locked={locked} destructive>
              <Trash2 />
              Remove file
            </WriteItem>
          </>
        )}
      </RowMenu>
    )
  }

  return (
    <>
      {unmanaged !== null && (
        <Banner tone="error">
          <div className="grid gap-2">
            <p className="text-pretty">
              <strong className="font-medium">The server refuses every change to this store.</strong> {unmanaged.text}
            </p>
            {unmanaged.command !== null && <Command text={unmanaged.command} />}
          </div>
        </Banner>
      )}

      {banners.map((problem) => (
        <ProblemBanner key={problem.key} problem={problem} slug={slug} />
      ))}

      <Panel
        title="Variables"
        count={lines.length}
        full
        actions={
          // Wrapped in a box of its own, so that on a phone the pill, the restart and Add take two lines rather than run off the panel.
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* A restart is prominent while one is pending, and only then. */}
            {pending !== null && (
              <Status tone="attention" shape="pill" title={pendingSentence(pending, slug)}>
                {PENDING_LABEL}
              </Status>
            )}
            {pending !== null && restartable && (
              <Button size="sm" onClick={() => actions.restart(slug)} className="max-md:h-10">
                <RotateCcw />
                Restart service
                {restartLocked && <LockGlyph />}
              </Button>
            )}
            {write && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-md:h-10" />}>
                  <Plus />
                  Add
                  {locked && <LockGlyph />}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <AddItem icon={Pencil} title="Variable" detail="A name and the value you type" onClick={() => openValue(null, "type")} />
                  <AddItem icon={Dices} title="Generated value" detail="Drawn on the server, never shown" onClick={() => openValue(null, "generate")} />
                  <AddItem icon={FileUp} title="File" detail="A key or a certificate, read whole" onClick={() => openFile(null)} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {(quietRestart || restorable) && (
              <RowMenu label={`More actions for ${slug}'s variables`} className="size-8">
                {quietRestart && (
                  <WriteItem onClick={() => actions.restart(slug)} locked={restartLocked}>
                    <RotateCcw />
                    Restart service
                  </WriteItem>
                )}
                {restorable && (
                  <WriteItem onClick={() => writing(() => setRestore({ slug, opening: next(), open: true }), "restore the previous version", "Restore previous version")} locked={locked}>
                    <Undo2 />
                    Restore previous version
                  </WriteItem>
                )}
              </RowMenu>
            )}
          </div>
        }
      >
        {lines.length === 0 ? (
          <InlineEmpty icon={Variable}>
            {nothing ? (
              <>
                No variable yet. Name them under <Code>secrets</Code> in its <Code>sitesolide.json</Code>, then deploy.
              </>
            ) : (
              "No variable yet."
            )}
          </InlineEmpty>
        ) : (
          <DataTable
            label={`Variables of ${slug}`}
            caption="The names not set first, then every name the store holds"
            narrowBelow="36rem"
            rows={lines}
            rowKey={(line) => line.name}
            columns={variableColumns}
            severity={(line) => (line.missing ? "error" : null)}
            menu={variableMenu}
          />
        )}
        <OtherNames slug={slug} store={store} />
      </Panel>

      {unmanagedFiles.map((one) => {
        const reason = splitReason(one.reason ?? "")
        return (
          <Banner key={one.name} tone="attention">
            <div className="grid gap-2">
              <p className="text-pretty">
                <strong className="font-mono font-medium">{one.name}</strong> is unmanaged. {reason.text}
              </p>
              {reason.command !== null && <Command text={reason.command} />}
            </div>
          </Banner>
        )
      })}

      {files.length > 0 && (
        <Panel title="Files" count={files.length} full>
          <DataTable
            label={`Files of ${slug}`}
            caption="Read whole by every service, at the path beside each name"
            narrowBelow="42rem"
            rows={files}
            rowKey={(one) => one.name}
            columns={fileColumns}
            severity={fileSeverity}
            menu={fileMenu}
          />
        </Panel>
      )}

      <StoreValueDialog
        target={value}
        open={value?.open ?? false}
        ownerReads={store.may.reveal}
        restartable={restartable}
        onClose={() => setValue((before) => before && { ...before, open: false })}
        onDone={(answer, restart) => done(answer, restart, () => setValue((before) => before && { ...before, open: false }))}
        onRefusal={actions.refusal}
        focusReturn={focusReturn}
      />

      <StoreFileDialog
        target={file}
        open={file?.open ?? false}
        restartable={restartable}
        onClose={() => setFile((before) => before && { ...before, open: false })}
        onDone={(answer, restart) => done(answer, restart, () => setFile((before) => before && { ...before, open: false }))}
        onRefusal={actions.refusal}
        focusReturn={focusReturn}
      />

      <StoreRestoreDialog
        target={restore}
        open={restore?.open ?? false}
        onClose={() => setRestore((before) => before && { ...before, open: false })}
        onRestored={() => {
          setRestore((before) => before && { ...before, open: false })
          announce(`Restored the previous version of the variables of ${slug}. Restart ${slug} to use it.`)
          actions.changed()
        }}
        onRefusal={actions.refusal}
        focusReturn={focusReturn}
      />

      <ConfirmDialog
        open={confirm?.open ?? false}
        title={
          <>
            Remove <span className="font-mono">{confirm?.name}</span>?
          </>
        }
        description={
          confirm?.kind === "file" ? (
            <>It goes out of the store. {slug} keeps its copy until it restarts, then starts without it.</>
          ) : (
            <>
              It goes out of the store. {slug} keeps its current value until it restarts
              {store.may.restore ? ", and Restore previous version can bring it back until the next change." : "."}
            </>
          )
        }
        action="Remove"
        actionInProgress="Removing…"
        destructive
        inProgress={confirming}
        error={confirmError}
        onConfirm={() => void confirmAction()}
        onClose={() => setConfirm((before) => before && { ...before, open: false })}
        focusReturn={focusReturn}
      />
    </>
  )
}
