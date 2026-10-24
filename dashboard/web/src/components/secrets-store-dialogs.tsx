import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode, type SyntheticEvent } from "react"
import { Eye, EyeOff, FileUp, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAnnounce } from "@/components/copy"
import { INPUT_DIALOG } from "@/components/page"
import type { FocusReturn, OnRefusal } from "@/components/secrets-dialogs"
import { generateStoreVariable, restoreStore, setStoreFile, setStoreVariable } from "@/lib/api"
import { size } from "@/lib/format"
import { MAX_UPLOAD_BYTES, refusalOf, succeeded } from "@/lib/secrets"
import {
  GENERATE_DEFAULT_SIZE,
  GENERATE_FORMATS_OFFERED,
  GENERATE_SIZES,
  credentialPath,
  encodeBase64,
  generatedSummary,
  restoreSummary,
} from "@/lib/store"
import { TONE_BANNER, TONE_TEXT } from "@/lib/tones"
import type { GenerateFormat, StoreChangeResponse } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The dialogs of a project's store: a value typed or drawn on the server, a
 * file uploaded, the store's previous version restored. Each sends what is asked as it stands and shows the steward's
 * refusal under its fields: the page judges no name, no size and no value.
 *
 * A value typed here leaves with the request and is forgotten: the field
 * unmounts with its dialog, and the answer carries names alone.
 */

function describedBy(...ids: (string | false)[]): string | undefined {
  return ids.filter((id): id is string => id !== false).join(" ") || undefined
}

function FieldError({ id, children }: { id: string; children: string }) {
  if (children === "") return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>
}

// --- A value: typed, or drawn on the server -------------------------------------

export type ValueTarget = {
  slug: string
  /** null: a name to choose, for a variable the store does not list yet. */
  name: string | null
  /** How the dialog opens; the person may switch. */
  mode: "type" | "generate"
  /** The store holds a value already: drawing one replaces it. */
  replaces: boolean
  /** Remounts the form on every opening: nothing typed before comes back. */
  opening: number
}

/**
 * Set a variable, by typing its value or by drawing one on the server. The
 * typed value is never prefilled, the steward never sending one; a drawn
 * value never reaches the page at all, the answer naming it alone.
 */
export function StoreValueDialog({
  target,
  open,
  ownerReads,
  restartable,
  onClose,
  onDone,
  onRefusal,
  focusReturn,
}: {
  target: ValueTarget | null
  open: boolean
  /** The viewer is the owner, who may reveal a value later: the help says so. */
  ownerReads: boolean
  /** The project has a service to restart: *& restart* is offered. */
  restartable: boolean
  onClose: () => void
  onDone: (answer: StoreChangeResponse, restart: boolean) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [inProgress, setInProgress] = useState<"save" | "restart" | null>(null)
  const name = target?.name ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && inProgress === null) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} className={cn("sm:max-w-lg", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug wrap-anywhere">
            {name === null ? (
              "Add a variable"
            ) : (
              <>
                Set <span className="font-mono">{name}</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Kept on the server, in the store of {target?.slug}, which every one of its services reads when it starts.{" "}
            {ownerReads ? "Once saved, only you can reveal it, here." : "Once saved, nobody reads it back but the owner of the server."}
          </DialogDescription>
        </DialogHeader>
        {target !== null && (
          <ValueForm
            key={target.opening}
            target={target}
            restartable={restartable}
            inProgress={inProgress}
            setInProgress={setInProgress}
            onDone={onDone}
            onRefusal={onRefusal}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ValueForm({
  target,
  restartable,
  inProgress,
  setInProgress,
  onDone,
  onRefusal,
}: {
  target: ValueTarget
  restartable: boolean
  inProgress: "save" | "restart" | null
  setInProgress: (inProgress: "save" | "restart" | null) => void
  onDone: (answer: StoreChangeResponse, restart: boolean) => void
  onRefusal: OnRefusal
}) {
  const fixed = target.name !== null
  const [mode, setMode] = useState(target.mode)
  const [name, setName] = useState(target.name ?? "")
  const [value, setValue] = useState("")
  const [visible, setVisible] = useState(false)
  const [format, setFormat] = useState<GenerateFormat>("hex")
  const [bytes, setBytes] = useState(GENERATE_DEFAULT_SIZE)
  const [error, setError] = useState("")
  const nameId = useId()
  const valueId = useId()
  const formatId = useId()
  const sizeId = useId()
  const helpId = useId()
  const errorId = useId()
  const busy = inProgress !== null
  const generating = mode === "generate"
  // A name typed here is not known to hold a value: the steward refuses a
  // draw over one that does, and the refusal says to replace it.
  const replaces = fixed && target.replaces

  async function save(restart: boolean) {
    if (busy) return
    setInProgress(restart ? "restart" : "save")
    setError("")
    try {
      const { status, body } = generating
        ? await generateStoreVariable({ slug: target.slug, name, format, bytes, replace: replaces })
        : await setStoreVariable({ slug: target.slug, name, value })
      if (succeeded(status) && body !== null) {
        setValue("")
        return onDone(body, restart)
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setError(message)
    } finally {
      setInProgress(null)
    }
  }

  const action = generating ? (replaces ? "Replace" : "Generate") : "Save"
  const doing = generating ? (replaces ? "Replacing…" : "Generating…") : "Saving…"

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
      className="grid gap-4"
    >
      {!fixed && (
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={describedBy(error !== "" && errorId)}
            className="h-10 font-mono sm:h-9"
          />
        </div>
      )}

      {/* Two ways to give a value: the segment chosen takes the muted grey, as the page's filters do. */}
      <div role="group" aria-label="How to give its value" className="inline-flex w-fit rounded-lg border bg-card p-0.5 dark:bg-background">
        {(
          [
            ["type", "Type a value"],
            ["generate", "Generate on the server"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            disabled={busy}
            onClick={() => {
              setMode(key)
              setError("")
            }}
            className={cn(
              "inline-flex h-9 items-center justify-center rounded-md px-2.5 text-[0.8125rem] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-[1.875rem]",
              mode === key ? "bg-muted font-medium text-strong" : "text-secondary-foreground hover:bg-muted/60 hover:text-strong",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!generating && (
        <div className="grid gap-2">
          <Label htmlFor={valueId}>Value</Label>
          <div className="relative">
            <Input
              id={valueId}
              type={visible ? "text" : "password"}
              value={value}
              autoFocus={fixed}
              onChange={(event) => setValue(event.target.value)}
              // A secret value is not a browser password: nothing to suggest, nothing to remember.
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              spellCheck={false}
              aria-invalid={(fixed && error !== "") || undefined}
              aria-describedby={describedBy(helpId, error !== "" && errorId)}
              className="h-10 pr-11 font-mono sm:h-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={visible ? "Hide value" : "Show value"}
              onClick={() => setVisible((before) => !before)}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground max-sm:size-8"
            >
              {visible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <p id={helpId} className="text-xs text-pretty text-muted-foreground">
            A key a provider gave you, typed or pasted. It is sent when you save, and not kept by this page.
          </p>
        </div>
      )}

      {generating && (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-2">
              <Label htmlFor={formatId}>Format</Label>
              <Select
                id={formatId}
                value={format}
                items={Object.fromEntries(GENERATE_FORMATS_OFFERED.map((offered) => [offered.format, offered.title]))}
                onValueChange={(next) => {
                  if (next !== null) setFormat(next as GenerateFormat)
                }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENERATE_FORMATS_OFFERED.map((offered) => (
                    <SelectItem key={offered.format} value={offered.format} description={offered.description}>
                      {offered.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor={sizeId}>Size</Label>
              <Select
                id={sizeId}
                value={String(bytes)}
                items={Object.fromEntries(GENERATE_SIZES.map((count) => [String(count), `${count} bytes`]))}
                onValueChange={(next) => {
                  if (next !== null) setBytes(Number(next))
                }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENERATE_SIZES.map((count) => (
                    <SelectItem key={count} value={String(count)} description={generatedSummary(format, count)}>
                      {`${count} bytes`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p id={helpId} className="text-xs text-pretty text-muted-foreground">
            {generatedSummary(format, bytes)}, drawn on the server and never shown here. For a key {target.slug} checks
            itself: a session secret, an internal token, a database password before its first use. A provider's key is
            typed instead.
          </p>
          {replaces && (
            <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-pretty", TONE_BANNER.attention)}>
              <TriangleAlert aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT.attention)} />
              <span>
                <Mono>{target.name}</Mono> already has a value. Generating replaces it on the server: the old one stops
                working at the next restart of {target.slug}, for anything that still uses it.
              </span>
            </div>
          )}
        </div>
      )}

      <FieldError id={errorId}>{error}</FieldError>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" className="max-sm:h-11" />} disabled={busy}>
          Cancel
        </DialogClose>
        <Button type="submit" variant={restartable ? "outline" : "default"} disabled={busy} className="max-sm:h-11">
          {inProgress === "save" ? doing : action}
        </Button>
        {restartable && (
          <Button type="button" disabled={busy} onClick={() => void save(true)} className="max-sm:h-11">
            {inProgress === "restart" ? doing : `${action} & restart`}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

// --- A file -----------------------------------------------------------------------

export type FileTarget = {
  slug: string
  /** null: a name to choose, for a file the store does not list yet. */
  name: string | null
  /** A file is there already, which this one replaces whole. */
  replaces: boolean
  opening: number
}

/**
 * A file read whole by every service of the project, chosen on the
 * workstation and read in the browser: sent as it stands, any bytes, when you
 * save. Nothing of the file there now is ever shown.
 */
export function StoreFileDialog({
  target,
  open,
  restartable,
  onClose,
  onDone,
  onRefusal,
  focusReturn,
}: {
  target: FileTarget | null
  open: boolean
  restartable: boolean
  onClose: () => void
  onDone: (answer: StoreChangeResponse, restart: boolean) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [inProgress, setInProgress] = useState<"save" | "restart" | null>(null)
  const name = target?.name ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && inProgress === null) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} className={cn("sm:max-w-lg", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug wrap-anywhere">
            {name === null ? (
              "Upload a file"
            ) : (
              <>
                {target?.replaces ? "Replace" : "Upload"} <span className="font-mono">{name}</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {target?.replaces ? "The new file replaces the whole one, and what it holds now is never shown here. " : ""}
            Every service of {target?.slug} reads it when it starts, under the path below.
          </DialogDescription>
        </DialogHeader>
        {target !== null && (
          <FileForm
            key={target.opening}
            target={target}
            restartable={restartable}
            inProgress={inProgress}
            setInProgress={setInProgress}
            onDone={onDone}
            onRefusal={onRefusal}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function FileForm({
  target,
  restartable,
  inProgress,
  setInProgress,
  onDone,
  onRefusal,
}: {
  target: FileTarget
  restartable: boolean
  inProgress: "save" | "restart" | null
  setInProgress: (inProgress: "save" | "restart" | null) => void
  onDone: (answer: StoreChangeResponse, restart: boolean) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const fixed = target.name !== null
  const [name, setName] = useState(target.name ?? "")
  const [chosen, setChosen] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState("")
  const picker = useRef<HTMLButtonElement>(null)
  const chooser = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const helpId = useId()
  const errorId = useId()
  const busy = inProgress !== null

  async function load(file: File | undefined) {
    if (file === undefined) return
    setError("")
    // Not the steward's size rule, which judges on send: only what keeps a
    // file dropped by mistake from freezing the tab.
    if (file.size > MAX_UPLOAD_BYTES) {
      const message = "This file is too large to be a secret. Choose a file under 1 MB."
      setError(message)
      return announce(message)
    }
    setChosen({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    if (!fixed && name === "") setName(file.name)
    announce(`Loaded ${file.name}`)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    if (!busy) void load(event.dataTransfer.files[0])
  }

  async function save(restart: boolean) {
    if (busy) return
    if (chosen === null) {
      setError("Choose a file first.")
      return picker.current?.focus()
    }
    setInProgress(restart ? "restart" : "save")
    setError("")
    try {
      const { status, body } = await setStoreFile({ slug: target.slug, name, content: encodeBase64(chosen.bytes) })
      if (succeeded(status) && body !== null) {
        setChosen(null)
        return onDone(body, restart)
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setError(message)
    } finally {
      setInProgress(null)
    }
  }

  function submit(event: SyntheticEvent) {
    event.preventDefault()
    void save(false)
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      {!fixed && (
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Name on the server</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={describedBy(helpId, error !== "" && errorId)}
            className="h-10 font-mono sm:h-9"
          />
        </div>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn("grid justify-items-start gap-2 rounded-lg border border-dashed px-3 py-3", dragOver && "ring-2 ring-ring")}
      >
        <Button
          ref={picker}
          type="button"
          variant="outline"
          size="sm"
          autoFocus={fixed}
          disabled={busy}
          onClick={() => chooser.current?.click()}
          className="max-sm:h-10"
        >
          <FileUp />
          {chosen === null ? "Choose a file" : "Choose another file"}
        </Button>
        <input
          ref={chooser}
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            void load(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <p className="text-xs text-pretty text-muted-foreground">
          {chosen === null ? (
            "Or drop it here. It is read in your browser and sent only when you save."
          ) : (
            <>
              <Mono>{chosen.name}</Mono>, {size(chosen.bytes.byteLength)}, read from your computer.
            </>
          )}
        </p>
      </div>

      <p id={helpId} className="text-xs text-pretty text-muted-foreground">
        {target.slug} reads it at{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono break-all">{credentialPath(name === "" ? "<name>" : name)}</code>
        : systemd adds the <Mono>files_</Mono> prefix, and the copy it hands the service is readable by the service alone.
      </p>

      <FieldError id={errorId}>{error}</FieldError>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" className="max-sm:h-11" />} disabled={busy}>
          Cancel
        </DialogClose>
        <Button type="submit" variant={restartable ? "outline" : "default"} disabled={busy} className="max-sm:h-11">
          {inProgress === "save" ? "Uploading…" : "Upload"}
        </Button>
        {restartable && (
          <Button type="button" disabled={busy} onClick={() => void save(true)} className="max-sm:h-11">
            {inProgress === "restart" ? "Uploading…" : "Upload & restart"}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

// --- Names in a sentence ---------------------------------------------------------

function NameList({ names }: { names: readonly string[] }) {
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

// --- Restoring the store's previous version --------------------------------------

type Phase<T> =
  | { phase: "checking" }
  | { phase: "ready"; reading: T }
  | { phase: "working"; reading: T }
  | { phase: "error"; message: string; reading: T | null }

export type RestoreTarget = { slug: string; opening: number }

/**
 * The store's variables put back as they were before their last change, the
 * two versions swapped. A dry run first, on opening: the dialog names what
 * would appear and disappear before anything is written.
 */
export function StoreRestoreDialog({
  target,
  open,
  onClose,
  onRestored,
  onRefusal,
  focusReturn,
}: {
  target: RestoreTarget | null
  open: boolean
  onClose: () => void
  onRestored: (answer: StoreChangeResponse) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <AlertDialogContent finalFocus={focusReturn} className="sm:max-w-md">
        {target !== null && (
          <RestoreBody key={target.opening} target={target} setBusy={setBusy} onRestored={onRestored} onRefusal={onRefusal} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

type RestoreReading = ReturnType<typeof restoreSummary>

function RestoreBody({
  target,
  setBusy,
  onRestored,
  onRefusal,
}: {
  target: RestoreTarget
  setBusy: (busy: boolean) => void
  onRestored: (answer: StoreChangeResponse) => void
  onRefusal: OnRefusal
}) {
  const [state, setState] = useState<Phase<RestoreReading>>({ phase: "checking" })
  const started = useRef(false)

  // The dry run, once per opening: the body remounts on every one.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const { status, body } = await restoreStore({ slug: target.slug, dryRun: true })
      if (succeeded(status) && body !== null && Array.isArray(body.appeared) && Array.isArray(body.disappeared)) {
        return setState({ phase: "ready", reading: restoreSummary(body) })
      }
      const message = onRefusal(refusalOf(status, body))
      setState({ phase: "error", message: message ?? "", reading: null })
    })()
  }, [target.slug, onRefusal])

  async function restore() {
    if (state.phase !== "ready") return
    const reading = state.reading
    setState({ phase: "working", reading })
    setBusy(true)
    try {
      const { status, body } = await restoreStore({ slug: target.slug, dryRun: false })
      if (succeeded(status) && body !== null) return onRestored(body)
      const message = onRefusal(refusalOf(status, body))
      setState({ phase: "error", message: message ?? "", reading })
    } finally {
      setBusy(false)
    }
  }

  const reading = state.phase === "checking" ? null : state.reading
  return (
    <>
      <AlertDialogHeader className="text-left max-sm:place-items-start">
        <AlertDialogTitle>Restore the previous version?</AlertDialogTitle>
        <AlertDialogDescription className="text-pretty">
          The variables on the server go back to how they were before their last change, and the current version is kept
          as the previous one. It may hold a key you meant to retire. {target.slug} keeps its current values until it
          restarts.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {state.phase === "checking" && <p className="text-sm text-muted-foreground">Checking what would change…</p>}
      {reading !== null && (
        <div className="grid gap-1 text-sm text-pretty">
          {reading.empty && <p>The same names come back; only values may change.</p>}
          {reading.appeared.length > 0 && (
            <p>
              Comes back: <NameList names={reading.appeared} />.
            </p>
          )}
          {reading.disappeared.length > 0 && (
            <p>
              Goes away: <NameList names={reading.disappeared} />.
            </p>
          )}
        </div>
      )}
      {state.phase === "error" && state.message !== "" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={state.phase === "working"} className="max-sm:h-11">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction
          disabled={state.phase !== "ready"}
          onClick={(event) => {
            // The dialog stays open for the answer: the server sees the restore through.
            event.preventDefault()
            void restore()
          }}
          className="max-sm:h-11"
        >
          {state.phase === "working" ? "Restoring…" : "Restore"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
