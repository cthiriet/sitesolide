import { useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Check, Copy, Ellipsis, Eye, EyeOff, KeyRound, LoaderCircle, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CopyFallback, useAnnounce } from "@/components/copy"
import { copyShortcut } from "@/lib/signin"
import { REVEAL_MS, hideCountdown } from "@/lib/secrets"

/** What a read returns to the row: the value, or the message to show (null if the page has already reacted). */
export type ReadResult = { value: string } | { message: string | null }

/** The visual feedback of a successful copy lasts two seconds, as elsewhere in the page. */
const FEEDBACK_MS = 2000

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Copying a value that has not arrived yet. Safari refuses `writeText` after a
 * request, the user gesture having been consumed by then; a `ClipboardItem` fed
 * with a promise, on the other hand, is accepted within the gesture itself and
 * fills in when the value arrives. False if the browser does not allow it: the
 * caller then falls back on `writeText`.
 */
export async function writeClipboardLater(reading: Promise<ReadResult>): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") return false
  const content = reading.then((result) => {
    if (!("value" in result)) throw new Error("read refused")
    return new Blob([result.value], { type: "text/plain" })
  })
  // The refusal is handled by the caller: no orphan rejection in the console.
  content.catch(() => {})
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": content })])
    return true
  } catch {
    return false
  }
}

/**
 * The column headers, when the file is wide enough to align them: the
 * measurement is the `file` container's, set by the file's block, and not
 * the screen's. Decorative: every button carries the name.
 */
export function VariablesHeader() {
  return (
    <div
      aria-hidden="true"
      className="hidden h-9 grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-center gap-x-4 border-y bg-muted/50 px-4 text-xs font-medium text-muted-foreground @xl/file:grid"
    >
      <span>Name</span>
      <span>Value</span>
      <span />
    </div>
  )
}

const ICON_BUTTON = "text-muted-foreground hover:text-foreground max-md:size-11"

/**
 * A value on screen, and everything that masks it again: thirty seconds, the
 * lock, the tab going to the background, the page being left, and the
 * unmounting of whatever displays it, on changing site or section. It only
 * lives in the state for as long as it is on screen.
 *
 * `fallback`: the value is shown selected because a copy was refused, for the
 * length of one reveal.
 */
export function useRevealedValue(unlocked: boolean) {
  const [value, setValue] = useState<string | null>(null)
  const [revealedAt, setRevealedAt] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [fallback, setFallback] = useState(false)
  const open = useRef(unlocked)

  function hide() {
    setValue(null)
    setRevealedAt(null)
    setFallback(false)
  }

  useEffect(() => {
    open.current = unlocked
    if (!unlocked) hide()
  }, [unlocked])

  useEffect(() => {
    if (value === null) return
    const timer = window.setTimeout(hide, REVEAL_MS)
    const countdown = window.setInterval(() => setClock(Date.now()), 1000)
    // Rendered straight away, and not on the next turn: a page cached by the
    // browser, or a capture for the tab preview, must not keep the value on
    // screen.
    const hideNow = () => flushSync(hide)
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") hideNow()
    }
    document.addEventListener("visibilitychange", handleVisibility)
    window.addEventListener("pagehide", hideNow)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(countdown)
      document.removeEventListener("visibilitychange", handleVisibility)
      window.removeEventListener("pagehide", hideNow)
    }
  }, [value])

  /** A value that arrives after a lock or a tab change is not displayed. */
  function canShow(): boolean {
    return open.current && document.visibilityState !== "hidden"
  }

  function show(text: string, asFallback: boolean) {
    const start = Date.now()
    setValue(text)
    setRevealedAt(start)
    setClock(start)
    setFallback(asFallback)
  }

  const remainingMs = revealedAt === null ? null : revealedAt + REVEAL_MS - clock
  return { value, fallback, remainingMs, hide, show, canShow, closeFallback: () => setFallback(false) }
}

/**
 * A variable: its name, its masked value, and its actions.
 *
 * Unlocked, the value is revealed for thirty seconds then masked again. It is
 * also masked again on locking, when the tab goes to the background or the page
 * is left, and when the row unmounts, on changing project or page. It only
 * lives in the state for as long as it is on screen. The copy reads it without
 * displaying it.
 *
 * Locked, the buttons stay in place: touching them asks for the password, then
 * the gesture has to be made again, which the page never replays.
 */
export function VariableRow({
  name,
  readable,
  unlocked,
  read,
  onUnlock,
  onEdit,
  onRemove,
}: {
  name: string
  /** False in a write-only file: no reveal and no copy, the value is never read back. */
  readable: boolean
  unlocked: boolean
  read: () => Promise<ReadResult>
  onUnlock: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const announce = useAnnounce()
  const { value, fallback, remainingMs, hide, show, canShow, closeFallback } = useRevealedValue(unlocked)
  const [reading, setReading] = useState<"reveal" | "copied" | null>(null)
  const [copied, setCopiedFlag] = useState(false)
  const [error, setError] = useState("")
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  function showError(message: string | null) {
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
      if (!("value" in result)) return showError(result.message)
      if (!canShow()) return
      show(result.value, false)
      announce(`${name} shown for ${REVEAL_MS / 1000} seconds`)
    } finally {
      setReading(null)
    }
  }

  function copySucceeded() {
    setCopiedFlag(true)
    announce(`${name} copied`)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedFlag(false), FEEDBACK_MS)
  }

  /** The fallback for a refused copy: the value selected, for the length of one reveal. */
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

  const busy = reading !== null
  const seconds = REVEAL_MS / 1000
  const lockedTitle = "Unlock to use"

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-1 pr-2 pl-4 @xl/file:min-h-11 @xl/file:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] @xl/file:gap-x-4 @xl/file:py-1.5">
      <code className="font-mono text-[0.8125rem] wrap-anywhere">{name}</code>

      {/* In a narrow file, the value only takes a line of its own once revealed. */}
      <div
        className={
          value === null
            ? "hidden min-w-0 overflow-hidden @xl/file:col-start-2 @xl/file:row-start-1 @xl/file:block"
            : "col-span-2 row-start-2 min-w-0 pr-2 pb-2 @xl/file:col-span-1 @xl/file:col-start-2 @xl/file:row-start-1 @xl/file:pr-0 @xl/file:pb-0"
        }
      >
        {value !== null && fallback ? (
          <CopyFallback text={value} onClose={closeFallback} />
        ) : value !== null ? (
          <div className="grid gap-1">
            <code className="block max-h-24 overflow-y-auto rounded-sm bg-muted px-2 py-1 font-mono text-xs break-all select-all">
              {value}
            </code>
            {remainingMs !== null && <span className="text-xs text-muted-foreground tabular-nums">{hideCountdown(remainingMs)}</span>}
          </div>
        ) : !readable ? (
          <span className="block truncate text-sm text-muted-foreground">Write-only</span>
        ) : (
          <span className="block truncate font-mono text-sm tracking-widest text-muted-foreground">
            <span aria-hidden="true">••••••••••••</span>
            <span className="sr-only">Value hidden</span>
          </span>
        )}
      </div>

      <div className="col-start-2 row-start-1 flex items-center justify-end @xl/file:col-start-3">
        {readable && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title={!unlocked ? lockedTitle : value !== null ? "Hide value" : `Show for ${seconds} seconds`}
              aria-label={
                !unlocked ? `Show ${name}, unlock first` : value !== null ? `Hide ${name}` : `Show ${name} for ${seconds} seconds`
              }
              aria-busy={reading === "reveal" || undefined}
              disabled={reading === "copied"}
              onClick={() => void toggle()}
              className={ICON_BUTTON}
            >
              {reading === "reveal" ? (
                <LoaderCircle className="motion-safe:animate-spin" />
              ) : value !== null ? (
                <EyeOff />
              ) : (
                <Eye />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title={!unlocked ? lockedTitle : "Copy value"}
              aria-label={unlocked ? `Copy ${name}` : `Copy ${name}, unlock first`}
              aria-busy={reading === "copied" || undefined}
              disabled={reading === "reveal"}
              onClick={() => void copy()}
              className={ICON_BUTTON}
            >
              {reading === "copied" ? (
                <LoaderCircle className="motion-safe:animate-spin" />
              ) : copied ? (
                <Check className="text-ok-text" />
              ) : (
                <Copy />
              )}
            </Button>

            {/* Reading on one side, writing on the other: the rule separates them. */}
            <span aria-hidden="true" className="mx-1.5 hidden h-4 w-px bg-border @xl/file:block" />
          </>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          title="Change value"
          aria-label={`Change ${name}`}
          disabled={busy}
          onClick={onEdit}
          className="hidden text-muted-foreground hover:text-foreground @xl/file:inline-flex"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Remove variable"
          aria-label={`Remove ${name}`}
          disabled={busy}
          onClick={onRemove}
          className="hidden text-muted-foreground hover:bg-destructive/10 hover:text-destructive @xl/file:inline-flex dark:hover:bg-destructive/15"
        >
          <Trash2 />
        </Button>

        {/* In a narrow file, the two writes go into a menu: four 44 px targets would crush the name. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More actions for ${name}`}
                disabled={busy}
                className={`${ICON_BUTTON} @xl/file:hidden`}
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onEdit} className="h-11">
              <Pencil />
              Change value
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove} className="h-11">
              <Trash2 />
              Remove variable
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error !== "" && <p className="col-span-full pb-2 text-xs text-destructive">{error}</p>}
    </li>
  )
}

/**
 * A variable that only changes through *Change password*: no value, no reveal,
 * no edit, no removal. The steward keeps a hash, which nobody reads back or
 * pastes.
 */
export function PasswordRow({ name, onChangePassword }: { name: string; onChangePassword: () => void }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 pr-2 pl-4 @xl/file:min-h-11 @xl/file:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] @xl/file:gap-x-4">
      <code className="font-mono text-[0.8125rem] wrap-anywhere">{name}</code>
      <span className="col-span-2 row-start-2 pb-1 text-xs text-pretty text-muted-foreground @xl/file:col-span-1 @xl/file:col-start-2 @xl/file:row-start-1 @xl/file:pb-0 @xl/file:text-sm">
        A password hash. It never shows: change the password instead.
      </span>
      <div className="col-start-2 row-start-1 flex justify-end @xl/file:col-start-3">
        <Button
          variant="outline"
          size="sm"
          data-password-variable={name}
          onClick={onChangePassword}
          className="max-md:h-10"
        >
          <KeyRound />
          Change password
        </Button>
      </div>
    </li>
  )
}
