import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Check,
  Copy,
  Dices,
  Ellipsis,
  Eye,
  EyeOff,
  FileKey,
  FileUp,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Command, CopyFallback, useAnnounce, useCopy } from "@/components/copy"
import { Banner, EmptyState, Panel, Status } from "@/components/page"
import { ProblemRow } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { ConfirmDialog, useOrigin } from "@/components/secrets-dialogs"
import {
  StoreFileDialog,
  StoreRestoreDialog,
  StoreValueDialog,
  type FileTarget,
  type RestoreTarget,
  type ValueTarget,
} from "@/components/secrets-store-dialogs"
import { writeClipboard, writeClipboardLater, useRevealedValue, type ReadResult } from "@/components/secrets-variables"
import { removeStoreFile, removeStoreVariables, revealStoreValue } from "@/lib/api"
import { copyShortcut } from "@/lib/signin"
import { REVEAL_MS, hideCountdown, projectProblems, readService, refusalOf, splitReason, succeeded } from "@/lib/secrets"
import {
  changeSummary,
  credentialPath,
  isEmptyFile,
  storeFileOffer,
  storeFileState,
  storeFileSummary,
  storeMissing,
  storeVariableOffer,
  UNDECLARED,
} from "@/lib/store"
import type { ProjectView, StoreChangeResponse, StoreFileView, StoreVariableView, StoreView } from "@/lib/types"

/*
 * A project's store, on its Secrets page: one list of variables, what the
 * manifest declares and the server lacks at the top, the files read whole,
 * the build's names and the public values for reference. Every write goes to
 * the steward, which judges;
 * a value is typed into a dialog and leaves with the request, and only the
 * owner's unlocked dashboard ever reads one back, for thirty seconds.
 */

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.8125rem] wrap-anywhere">{children}</code>
}

function Code({ children }: { children: string }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap">{children}</code>
}

const ICON_BUTTON = "text-muted-foreground hover:text-foreground max-md:size-11"

type Confirm = { kind: "variable" | "file"; slug: string; name: string; open: boolean }

// --- A variable --------------------------------------------------------------------

/**
 * A variable the store holds: its name, a word when the manifest does not
 * declare it, and what the viewer may do with it. The
 * owner reveals a value the store holds for thirty seconds, masked again on
 * locking, tab hidden, page left or row unmounted; nobody else has a reveal
 * control.
 */
function StoreVariableRow({
  store,
  variable,
  unlocked,
  onSet,
  onGenerate,
  onRemove,
  onUnlock,
  read,
}: {
  store: StoreView
  variable: StoreVariableView
  unlocked: boolean
  onSet: () => void
  onGenerate: () => void
  onRemove: () => void
  onUnlock: () => void
  read: () => Promise<ReadResult>
}) {
  const announce = useAnnounce()
  const offer = storeVariableOffer(store, variable)
  const { value, fallback, remainingMs, hide, show, canShow, closeFallback } = useRevealedValue(unlocked)
  const [reading, setReading] = useState<"reveal" | "copy" | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const copyTimer = useRef<number | undefined>(undefined)
  const name = variable.name

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  function fail(message: string | null) {
    if (message === null) return
    setError(message)
    announce(message)
  }

  async function toggle() {
    if (!unlocked) return onUnlock()
    if (value !== null) {
      hide()
      return announce(`${name} hidden`)
    }
    if (reading !== null) return
    setError("")
    setReading("reveal")
    try {
      const result = await read()
      if (!("value" in result)) return fail(result.message)
      if (!canShow()) return
      show(result.value, false)
      announce(`${name} shown for ${REVEAL_MS / 1000} seconds`)
    } finally {
      setReading(null)
    }
  }

  function copySucceeded() {
    setCopied(true)
    announce(`${name} copied`)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  function copyRefused(text: string) {
    if (!canShow()) return
    show(text, true)
    announce(`Couldn't copy automatically. Press ${copyShortcut(navigator.userAgent)} to copy the selected text.`)
  }

  async function copy() {
    if (!unlocked) return onUnlock()
    if (reading !== null) return
    setError("")
    if (value !== null) {
      if (await writeClipboard(value)) return copySucceeded()
      return copyRefused(value)
    }
    setReading("copy")
    try {
      const pending = read()
      if (await writeClipboardLater(pending)) return copySucceeded()
      const result = await pending
      if (!("value" in result)) return fail(result.message)
      if (await writeClipboard(result.value)) return copySucceeded()
      copyRefused(result.value)
    } finally {
      setReading(null)
    }
  }

  const busy = reading !== null
  const writes = offer.set || offer.generate || offer.remove
  const seconds = REVEAL_MS / 1000

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-2 pr-2 pl-4 @2xl/store:min-h-11 @2xl/store:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] @2xl/store:gap-x-4">
      <Mono>{name}</Mono>

      <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pr-2 text-xs text-muted-foreground @2xl/store:col-span-1 @2xl/store:col-start-2 @2xl/store:row-start-1 @2xl/store:pr-0">
        {value !== null && fallback ? (
          <CopyFallback text={value} onClose={closeFallback} />
        ) : value !== null ? (
          <div className="grid w-full gap-1">
            <code className="block max-h-24 overflow-y-auto rounded-sm bg-muted px-2 py-1 font-mono text-xs break-all text-foreground select-all">
              {value}
            </code>
            {remainingMs !== null && <span className="tabular-nums">{hideCountdown(remainingMs)}</span>}
          </div>
        ) : (
          !variable.declared && <span>{UNDECLARED}</span>
        )}
      </div>

      <div className="col-start-2 row-start-1 flex items-center justify-end @2xl/store:col-start-3">
        {offer.reveal && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title={!unlocked ? "Unlock to use" : value !== null ? "Hide value" : `Reveal for ${seconds} seconds`}
              aria-label={!unlocked ? `Reveal ${name}, unlock first` : value !== null ? `Hide ${name}` : `Reveal ${name} for ${seconds} seconds`}
              aria-busy={reading === "reveal" || undefined}
              disabled={reading === "copy"}
              onClick={() => void toggle()}
              className={ICON_BUTTON}
            >
              {reading === "reveal" ? <LoaderCircle className="motion-safe:animate-spin" /> : value !== null ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title={!unlocked ? "Unlock to use" : "Copy value"}
              aria-label={unlocked ? `Copy ${name}` : `Copy ${name}, unlock first`}
              aria-busy={reading === "copy" || undefined}
              disabled={reading === "reveal"}
              onClick={() => void copy()}
              className={ICON_BUTTON}
            >
              {reading === "copy" ? <LoaderCircle className="motion-safe:animate-spin" /> : copied ? <Check className="text-ok-text" /> : <Copy />}
            </Button>
            {writes && <span aria-hidden="true" className="mx-1.5 hidden h-4 w-px bg-border @2xl/store:block" />}
          </>
        )}

        {offer.set && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onSet}
            aria-label={`Set ${name}`}
            className="hidden text-muted-foreground hover:text-foreground @2xl/store:inline-flex"
          >
            <Pencil />
            Set
          </Button>
        )}
        {/* Set stays in sight in a wide panel; the rarer writes, and every write in a narrow one, are in the menu. */}
        {writes && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${name}`}
                  disabled={busy}
                  className={ICON_BUTTON}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {offer.set && (
                <DropdownMenuItem onClick={onSet} className="h-11">
                  <Pencil />
                  Set
                </DropdownMenuItem>
              )}
              {offer.generate && (
                <DropdownMenuItem onClick={onGenerate} className="h-11">
                  <Dices />
                  Generate
                </DropdownMenuItem>
              )}
              {offer.remove && (
                <DropdownMenuItem variant="destructive" onClick={onRemove} className="h-11">
                  <Trash2 />
                  Remove
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {error !== "" && <p className="col-span-full pb-1 text-xs text-destructive">{error}</p>}
    </li>
  )
}

// --- What is missing ---------------------------------------------------------------

/** The declared names and files with no value on the server, flagged first, each with what sets it. */
function MissingBlock({
  slug,
  store,
  onSet,
  onGenerate,
  onUpload,
}: {
  slug: string
  store: StoreView
  onSet: (name: string) => void
  onGenerate: (name: string) => void
  onUpload: (name: string) => void
}) {
  const { variables, files } = storeMissing(store)
  if (variables.length + files.length === 0) return null
  const write = store.may.write && store.state !== "unmanaged"
  return (
    <div className="border-b bg-destructive/4 dark:bg-destructive/6">
      <p className="px-4 pt-3 text-sm text-pretty">
        <strong className="font-medium text-destructive">Not set.</strong> {slug} starts without{" "}
        {variables.length + files.length === 1 ? "it" : "them"}.
      </p>
      <ul aria-label={`Not set for ${slug}`} className="divide-y divide-divider">
        {variables.map((name) => (
          <li key={`variable-${name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-2 pl-4">
            <Mono>{name}</Mono>
            {write && (
              <div className="ml-auto flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => onSet(name)} aria-label={`Set ${name}`} className="max-md:h-10">
                  <Pencil />
                  Set
                </Button>
                <Button variant="outline" size="sm" onClick={() => onGenerate(name)} aria-label={`Generate ${name}`} className="max-md:h-10">
                  <Dices />
                  Generate
                </Button>
              </div>
            )}
          </li>
        ))}
        {files.map((name) => (
          <li key={`file-${name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-2 pl-4">
            <FileKey aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <Mono>{name}</Mono>
            {write && (
              <div className="ml-auto flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => onUpload(name)} aria-label={`Upload ${name}`} className="max-md:h-10">
                  <FileUp />
                  Upload
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- A file ------------------------------------------------------------------------

/** The path a service reads a file at, to copy into its code as it stands. */
function CredentialPath({ name }: { name: string }) {
  const path = credentialPath(name)
  const { state, copy, reset } = useCopy("Path copied")
  if (state === "failure") return <CopyFallback text={path} onClose={reset} />
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <code className="min-w-0 font-mono text-xs break-all text-secondary-foreground">{path}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy the path of ${name}`}
        title="Copy path"
        onClick={() => void copy(path)}
        className="shrink-0 text-muted-foreground hover:text-foreground max-md:size-9"
      >
        {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
      </Button>
    </span>
  )
}

function StoreFileRow({
  store,
  file,
  serverNow,
  onUpload,
  onRemove,
}: {
  store: StoreView
  file: StoreFileView
  serverNow: number
  onUpload: () => void
  onRemove: () => void
}) {
  const offer = storeFileOffer(store, file)
  const state = storeFileState(file)
  const present = file.state === "set" || isEmptyFile(file)
  const summary = storeFileSummary(file, serverNow)
  const reason = file.state === "unmanaged" && file.reason !== null ? splitReason(file.reason) : null
  return (
    <li className="grid gap-1 py-2.5 pr-2 pl-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileKey aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <Mono>{file.name}</Mono>
        {state !== null && <Status tone={state.tone}>{state.text}</Status>}
        {!file.declared && <span className="text-xs text-muted-foreground">{UNDECLARED}</span>}
        {summary !== "" && <span className="text-xs text-muted-foreground tabular-nums">{summary}</span>}
        <div className="ml-auto flex items-center gap-1">
          {offer.upload && (
            <Button variant="ghost" size="sm" onClick={onUpload} aria-label={`${present ? "Replace" : "Upload"} ${file.name}`} className="text-muted-foreground hover:text-foreground max-md:h-10">
              <FileUp />
              {present ? "Replace" : "Upload"}
            </Button>
          )}
          {offer.remove && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Remove from the store"
              aria-label={`Remove ${file.name}`}
              onClick={onRemove}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-md:size-10 dark:hover:bg-destructive/15"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      <CredentialPath name={file.name} />
      {reason !== null && (
        <div className="grid max-w-2xl gap-2 pt-1 pr-2">
          <p className="text-sm text-pretty">{reason.text}</p>
          {reason.command !== null && <Command text={reason.command} />}
        </div>
      )}
    </li>
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
  const service = project.service === null ? null : readService(project.service, actions.serverNow)
  const problems = projectProblems(project, actions.serverNow).filter(
    (problem) => problem.key === "service" || problem.key === "pending" || problem.key === "store-unread",
  )
  const waiting = problems.some((problem) => problem.key === "pending")
  const byName = new Map(store.variables.map((variable) => [variable.name, variable]))

  /** A new number per opening, read when the dialog opens, which may be after an unlock: never a stale one. */
  function next(): number {
    openings.current += 1
    return openings.current
  }

  /** An action that writes: remembered where it started, asked for the unlock first when locked. */
  function writing(open: () => void) {
    remember()
    actions.require(open)
  }

  function openValue(name: string | null, mode: "type" | "generate") {
    const replaces = name !== null && (byName.get(name)?.source ?? "none") !== "none"
    writing(() => setValue({ slug, name, mode, replaces, opening: next(), open: true }))
  }

  function openFile(name: string | null) {
    const replaces = name !== null && store.files.some((one) => one.name === name && (one.state === "set" || isEmptyFile(one)))
    writing(() => setFile({ slug, name, replaces, opening: next(), open: true }))
  }

  function askConfirm(target: Confirm) {
    writing(() => {
      setConfirmError("")
      setConfirm(target)
    })
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
      // A reveal is journaled: the log shows it.
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
  const nothing = store.variables.length === 0 && store.missing.length === 0 && store.files.length === 0

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

      <Panel
        title="Variables"
        count={store.variables.length}
        full
        description={
          service === null || project.service === null ? (
            <span className="text-sm">No service: nothing reads these at startup.</span>
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
          <>
            {store.previous && store.may.restore && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => writing(() => setRestore({ slug, opening: next(), open: true }))}
                className="text-muted-foreground hover:text-foreground max-md:h-10"
              >
                <Undo2 />
                <span className="max-sm:sr-only">Restore previous version</span>
              </Button>
            )}
            {restartable && (
              <Button variant={waiting ? "default" : "outline"} size="sm" onClick={() => actions.restart(slug)} className="max-md:h-10">
                <RotateCcw />
                Restart service
              </Button>
            )}
          </>
        }
      >
        {problems.length > 0 && (
          <ul aria-label={`What needs attention in ${slug}`} className="divide-y divide-divider border-b">
            {problems.map((problem) => (
              <ProblemRow key={problem.key} problem={problem} slug={slug} />
            ))}
          </ul>
        )}

        <MissingBlock
          slug={slug}
          store={store}
          onSet={(name) => openValue(name, "type")}
          onGenerate={(name) => openValue(name, "generate")}
          onUpload={(name) => openFile(name)}
        />

        {nothing ? (
          <EmptyState icon={FileKey} title={`${slug} has no secrets yet`} compact>
            Name them under <Code>secrets</Code> in its <Code>sitesolide.json</Code>, then deploy.
          </EmptyState>
        ) : (
          <div className="@container/store">
            <ul aria-label={`Variables of ${slug}`} className="divide-y divide-divider">
              {store.variables
                .filter((variable) => variable.source !== "none")
                .map((variable) => (
                  <StoreVariableRow
                    key={variable.name}
                    store={store}
                    variable={variable}
                    unlocked={actions.state.open}
                    onSet={() => openValue(variable.name, "type")}
                    onGenerate={() => openValue(variable.name, "generate")}
                    onRemove={() => askConfirm({ kind: "variable", slug, name: variable.name, open: true })}
                    onUnlock={() => actions.unlock()}
                    read={() => read(variable.name)}
                  />
                ))}
            </ul>
          </div>
        )}

        {write && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            {store.files.length === 0 && (
              <Button variant="outline" size="sm" onClick={() => openFile(null)} className="max-md:h-10">
                <FileUp />
                Upload file
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => openValue(null, "type")} className="max-md:h-10">
              <Plus />
              Add variable
            </Button>
          </div>
        )}
      </Panel>

      {store.files.length > 0 && (
        <Panel
          title="Files"
          count={store.files.length}
          full
          description="Read whole by every service, at the path under each name."
          actions={
            write ? (
              <Button variant="outline" size="sm" onClick={() => openFile(null)} className="max-md:h-10">
                <FileUp />
                Upload file
              </Button>
            ) : undefined
          }
        >
          <ul aria-label={`Files of ${slug}`} className="divide-y divide-divider">
            {store.files.map((one) => (
              <StoreFileRow
                key={one.name}
                store={store}
                file={one}
                serverNow={actions.serverNow}
                onUpload={() => openFile(one.name)}
                onRemove={() => askConfirm({ kind: "file", slug, name: one.name, open: true })}
              />
            ))}
          </ul>
        </Panel>
      )}

      {store.build.length > 0 && (
        <Panel
          title="Build secrets"
          count={store.build.length}
          full
          description={
            <>
              Read where you deploy, from the environment or{" "}
              <code className="font-mono">~/.config/sitesolide/secrets/{slug}.env</code>. Never on the server.
            </>
          }
        >
          <ul aria-label={`Build secrets of ${slug}`} className="divide-y divide-divider">
            {store.build.map((name) => (
              <li key={name} className="px-4 py-2.5">
                <Mono>{name}</Mono>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {store.public.length > 0 && (
        <Panel
          title="Public variables"
          count={store.public.length}
          full
          description={
            <>
              From <Code>env</Code> in <Code>sitesolide.json</Code>: change them there, then deploy.
            </>
          }
        >
          <ul aria-label={`Public variables of ${slug}`} className="divide-y divide-divider">
            {store.public.map((entry) => (
              <li key={entry.name} className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                <Mono>{entry.name}</Mono>
                <code className="min-w-0 font-mono text-xs break-all text-secondary-foreground">{entry.value}</code>
              </li>
            ))}
          </ul>
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
            <>
              It goes out of the store. {slug} keeps its copy until it restarts, then starts without it.
            </>
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
