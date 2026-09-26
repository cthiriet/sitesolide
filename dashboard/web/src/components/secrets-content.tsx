import { useId, useRef, useState, type DragEvent, type SyntheticEvent } from "react"
import { Check, Copy, Eye, EyeOff, FileUp, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { CopyFallback, useAnnounce } from "@/components/copy"
import { INPUT_DIALOG } from "@/components/page"
import type { FocusReturn, OnRefusal } from "@/components/secrets-dialogs"
import { writeClipboard, writeClipboardLater, useRevealedValue, type ReadResult } from "@/components/secrets-variables"
import { replaceSecretContent } from "@/lib/api"
import { size } from "@/lib/format"
import { copyShortcut } from "@/lib/signin"
import { REVEAL_MS, refusalOf, readLocalText, hideCountdown, succeeded } from "@/lib/secrets"
import { cn } from "@/lib/utils"

/**
 * A file the service reads in one go, a private key for instance: it is
 * replaced whole, and only read if the steward says it is readable. The old
 * contents are never displayed in order to replace them.
 */

// --- Reading readable contents ---------------------------------------------------

/**
 * *Reveal* and *Copy* for a readable file, like a variable: thirty seconds on
 * screen, masked again on locking, tab hidden, page left or section changed.
 * The copy reads it without displaying it.
 */
export function ContentReveal({
  file,
  unlocked,
  read,
  onUnlock,
}: {
  file: string
  unlocked: boolean
  read: () => Promise<ReadResult>
  onUnlock: () => void
}) {
  const announce = useAnnounce()
  const { value, fallback, remainingMs, hide, show, canShow, closeFallback } = useRevealedValue(unlocked)
  const [reading, setReading] = useState<"reveal" | "copied" | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")

  function showError(message: string | null) {
    if (message === null) return
    setError(message)
    announce(message)
  }

  function copySucceeded() {
    setCopied(true)
    announce(`${file} copied`)
    window.setTimeout(() => setCopied(false), 2000)
  }

  function copyRefused(text: string) {
    if (!canShow()) return
    show(text, true)
    announce(`Couldn't copy automatically. Press ${copyShortcut(navigator.userAgent)} to copy the selected text.`)
  }

  async function reveal() {
    if (!unlocked) return onUnlock()
    if (value !== null) {
      hide()
      return announce(`${file} hidden`)
    }
    if (reading !== null) return
    setError("")
    setReading("reveal")
    try {
      const result = await read()
      if (!("value" in result)) return showError(result.message)
      if (!canShow()) return
      show(result.value, false)
      announce(`${file} shown for ${REVEAL_MS / 1000} seconds`)
    } finally {
      setReading(null)
    }
  }

  async function copy() {
    if (!unlocked) return onUnlock()
    if (reading !== null) return
    setError("")
    if (value !== null) {
      if (await writeClipboard(value)) return copySucceeded()
      return copyRefused(value)
    }
    setReading("copied")
    try {
      const pending = read()
      if (await writeClipboardLater(pending)) return copySucceeded()
      const result = await pending
      if (!("value" in result)) return showError(result.message)
      if (await writeClipboard(result.value)) return copySucceeded()
      copyRefused(result.value)
    } finally {
      setReading(null)
    }
  }

  const lockedTitle = "Unlock to use"
  return (
    <div className="grid gap-2 px-4 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          title={unlocked ? undefined : lockedTitle}
          aria-busy={reading === "reveal" || undefined}
          disabled={reading === "copied"}
          onClick={() => void reveal()}
          className="max-md:h-10"
        >
          {reading === "reveal" ? (
            <LoaderCircle className="motion-safe:animate-spin" />
          ) : value !== null ? (
            <EyeOff />
          ) : (
            <Eye />
          )}
          {value !== null ? "Hide" : "Reveal"}
          {!unlocked && <span className="sr-only">, unlock first</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title={unlocked ? undefined : lockedTitle}
          aria-busy={reading === "copied" || undefined}
          disabled={reading === "reveal"}
          onClick={() => void copy()}
          className="text-muted-foreground hover:text-foreground max-md:h-10"
        >
          {reading === "copied" ? (
            <LoaderCircle className="motion-safe:animate-spin" />
          ) : copied ? (
            <Check className="text-ok-text" />
          ) : (
            <Copy />
          )}
          {copied ? "Copied" : "Copy"}
          {!unlocked && <span className="sr-only">, unlock first</span>}
        </Button>
        {value !== null && remainingMs !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">{hideCountdown(remainingMs)}</span>
        )}
      </div>
      {value !== null && fallback && <CopyFallback text={value} lines={4} onClose={closeFallback} />}
      {value !== null && !fallback && (
        <pre className="max-h-64 overflow-auto rounded-sm bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all select-all">
          {value}
        </pre>
      )}
      {error !== "" && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

// --- Replacing -------------------------------------------------------------------

export type ContentTarget = { slug: string; file: string; opening: number }

/**
 * The new contents, pasted or read from a file on the workstation, masked by
 * default. Nothing is sent before *Save*; the steward judges the contents and
 * its refusal is shown under the field. The form is remounted on every
 * opening: nothing from a previous entry reappears.
 */
export function ContentDialog({
  target,
  open,
  writeOnly,
  restartable,
  onClose,
  onReplaced,
  onRefusal,
  focusReturn,
}: {
  target: ContentTarget | null
  open: boolean
  writeOnly: boolean
  /** The site has a service to restart: *Save & restart* is offered. */
  restartable: boolean
  onClose: () => void
  onReplaced: (target: { slug: string; file: string }, restart: boolean) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const [inProgress, setEnCours] = useState<"save" | "restart" | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && inProgress === null) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} className={cn("sm:max-w-xl", INPUT_DIALOG)}>
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug wrap-anywhere">
            Replace <span className="font-mono">{target?.file}</span>
          </DialogTitle>
          <DialogDescription className="text-pretty">
            The new content replaces the whole file, and what it holds now is never shown here.
            {writeOnly &&
              " This file is write-only: once saved, it can't be read back, not even from this dashboard."}{" "}
            {target?.slug} reads it the next time it starts.
          </DialogDescription>
        </DialogHeader>
        {target !== null && (
          <ContentForm
            key={target.opening}
            target={target}
            restartable={restartable}
            inProgress={inProgress}
            setEnCours={setEnCours}
            onReplaced={onReplaced}
            onRefusal={onRefusal}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ContentForm({
  target,
  restartable,
  inProgress,
  setEnCours,
  onReplaced,
  onRefusal,
}: {
  target: ContentTarget
  restartable: boolean
  inProgress: "save" | "restart" | null
  setEnCours: (inProgress: "save" | "restart" | null) => void
  onReplaced: (target: { slug: string; file: string }, restart: boolean) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const [content, setContent] = useState("")
  const [visible, setVisible] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [loaded, setLoadedFile] = useState<{ name: string; bytes: number } | null>(null)
  const [error, setError] = useState("")
  const field = useRef<HTMLTextAreaElement>(null)
  const choice = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const helpId = useId()
  const errorId = useId()
  const busy = inProgress !== null

  async function loadFile(file: File | undefined) {
    if (file === undefined) return
    setError("")
    const parsed = readLocalText(new Uint8Array(await file.arrayBuffer()))
    if ("error" in parsed) {
      setError(parsed.error)
      return announce(parsed.error)
    }
    setContent(parsed.text)
    setLoadedFile({ name: file.name, bytes: file.size })
    // Only the name is announced, never the contents.
    announce(`Loaded ${file.name}`)
    field.current?.focus()
  }

  function onDropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    if (busy) return
    void loadFile(event.dataTransfer.files[0])
  }

  async function save(restart: boolean) {
    if (busy) return
    setEnCours(restart ? "restart" : "save")
    setError("")
    try {
      const { status, body } = await replaceSecretContent({ slug: target.slug, file: target.file, content })
      if (succeeded(status)) {
        setContent("")
        return onReplaced({ slug: target.slug, file: target.file }, restart)
      }
      const message = onRefusal(refusalOf(status, body))
      if (message !== null) setError(message)
    } finally {
      setEnCours(null)
    }
  }

  function submit(event: SyntheticEvent) {
    event.preventDefault()
    void save(false)
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={fieldId}>New content</Label>
          <div className="-mr-2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => choice.current?.click()}
              className="max-sm:h-9"
            >
              <FileUp />
              Load a file
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={visible}
              onClick={() => setVisible((before) => !before)}
              className="text-muted-foreground hover:text-foreground max-sm:h-9"
            >
              {visible ? <EyeOff /> : <Eye />}
              {visible ? "Hide" : "Show"}
            </Button>
          </div>
          <input
            ref={choice}
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              void loadFile(event.target.files?.[0])
              event.target.value = ""
            }}
          />
        </div>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDropFile}
          className={cn("rounded-lg", dragOver && "ring-3 ring-ring/50")}
        >
          <textarea
            ref={field}
            id={fieldId}
            value={content}
            autoFocus
            rows={9}
            wrap="off"
            onChange={(event) => {
              setContent(event.target.value)
              setLoadedFile(null)
            }}
            // A secret is neither a browser password nor a text to correct: nothing to suggest, nothing to remember.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            aria-invalid={error !== "" || undefined}
            aria-describedby={[helpId, error !== "" ? errorId : ""].filter(Boolean).join(" ")}
            className={cn(
              "block min-h-40 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
              // Masked by default, like a password field, which this field cannot be.
              !visible && "[-webkit-text-security:disc]",
            )}
          />
        </div>
        <p id={helpId} className="text-xs text-pretty text-muted-foreground">
          {loaded === null
            ? "Paste it here, or drop a text file on this field. It is read in your browser and sent only when you save."
            : `Loaded ${loaded.name} (${size(loaded.bytes)}) from your computer.`}
        </p>
        {error !== "" && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" className="max-sm:h-11" />} disabled={busy}>
          Cancel
        </DialogClose>
        <Button type="submit" variant={restartable ? "outline" : "default"} disabled={busy} className="max-sm:h-11">
          {inProgress === "save" ? "Saving…" : "Save"}
        </Button>
        {restartable && (
          <Button type="button" disabled={busy} onClick={() => void save(true)} className="max-sm:h-11">
            {inProgress === "restart" ? "Saving…" : "Save & restart"}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
