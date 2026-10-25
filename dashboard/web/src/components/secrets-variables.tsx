import { useEffect, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { Check, Copy, Eye, EyeOff, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { CopyFallback, useAnnounce } from "@/components/copy"
import { LockGlyph } from "@/components/unlock"
import { copyShortcut } from "@/lib/signin"
import { REVEAL_MS, hideCountdown } from "@/lib/secrets"
import { cn } from "@/lib/utils"

/*
 * A list of values the owner may reveal or copy, a store's variables or a
 * platform file's: one value on screen at a time, for thirty seconds, masked
 * again on locking, the tab going to the background, the page being left
 * and the list unmounting, on changing site or section. A value only lives
 * in the state for as long as it is on screen; a copy reads it without
 * showing it.
 *
 * The state is the list's, not a row's: the value shows in one cell, its
 * buttons sit in another, and the row menu has them too, all of a row that
 * the list pattern (components/data-table.tsx) draws cell by cell.
 */

/** What a read returns to the row: the value, or the message to show (null if the page has already reacted). */
export type ReadResult = { value: string } | { message: string | null }

/** The visual feedback of a successful copy lasts two seconds, as elsewhere in the page. */
const FEEDBACK_MS = 2000

async function writeClipboard(text: string): Promise<boolean> {
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
async function writeClipboardLater(reading: Promise<ReadResult>): Promise<boolean> {
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

/** The value on screen: whose, since when, and whether it shows because a copy was refused. */
type Shown = { key: string; value: string; at: number; fallback: boolean }

export type ValueTable = {
  unlocked: boolean
  /** The value of `key` on screen, or null. */
  shown: (key: string) => { value: string; fallback: boolean; remainingMs: number } | null
  /** `key`'s read in flight, and which. */
  reading: (key: string) => "reveal" | "copy" | null
  /** Any read in flight: the rows' writes wait for it. */
  busy: boolean
  copied: (key: string) => boolean
  error: (key: string) => string
  toggle: (key: string, name: string) => Promise<void>
  copy: (key: string, name: string) => Promise<void>
  closeFallback: () => void
}

/**
 * The reveal and the copy of a list's values, `key` naming a row ("CMS_TOKEN",
 * "dashboard-monitor.env/HEARTBEAT_URL") and `name` what is announced. Locked,
 * both ask for the unlock, `onUnlock` titled after what waits, "reveal
 * CMS_TOKEN", and the gesture has to be made again, which the page never
 * replays.
 */
export function useValueTable(unlocked: boolean, read: (key: string) => Promise<ReadResult>, onUnlock: (purpose: string) => void): ValueTable {
  const announce = useAnnounce()
  const [current, setCurrent] = useState<Shown | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [reading, setReading] = useState<{ key: string; kind: "reveal" | "copy" } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const open = useRef(unlocked)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  function hide() {
    setCurrent(null)
  }

  useEffect(() => {
    open.current = unlocked
    if (!unlocked) hide()
  }, [unlocked])

  useEffect(() => {
    if (current === null) return
    const timer = window.setTimeout(hide, current.at + REVEAL_MS - Date.now())
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
  }, [current])

  /** A value that arrives after a lock or a tab change is not displayed. */
  function canShow(): boolean {
    return open.current && document.visibilityState !== "hidden"
  }

  function show(key: string, value: string, fallback: boolean) {
    const at = Date.now()
    setCurrent({ key, value, at, fallback })
    setClock(at)
  }

  function setError(key: string, message: string) {
    setErrors((before) => ({ ...before, [key]: message }))
  }

  function showError(key: string, message: string | null) {
    if (message === null) return
    setError(key, message)
    announce(message)
  }

  async function toggle(key: string, name: string) {
    if (!unlocked) return onUnlock(`reveal ${name}`)
    if (current?.key === key) {
      hide()
      return announce(`${name} hidden`)
    }
    if (reading !== null) return
    setError(key, "")
    setReading({ key, kind: "reveal" })
    try {
      const result = await read(key)
      if (!("value" in result)) return showError(key, result.message)
      if (!canShow()) return
      show(key, result.value, false)
      announce(`${name} shown for ${REVEAL_MS / 1000} seconds`)
    } finally {
      setReading(null)
    }
  }

  function copySucceeded(key: string, name: string) {
    setCopied(key)
    announce(`${name} copied`)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), FEEDBACK_MS)
  }

  /** The fallback for a refused copy: the value selected, for the length of one reveal. */
  function copyRefused(key: string, text: string) {
    if (!canShow()) return
    show(key, text, true)
    announce(`Couldn't copy automatically. Press ${copyShortcut(navigator.userAgent)} to copy the selected text.`)
  }

  async function copy(key: string, name: string) {
    if (!unlocked) return onUnlock(`copy ${name}`)
    if (reading !== null) return
    setError(key, "")
    if (current?.key === key) {
      if (await writeClipboard(current.value)) return copySucceeded(key, name)
      return copyRefused(key, current.value)
    }
    setReading({ key, kind: "copy" })
    try {
      const pending = read(key)
      if (await writeClipboardLater(pending)) return copySucceeded(key, name)
      const result = await pending
      if (!("value" in result)) return showError(key, result.message)
      if (await writeClipboard(result.value)) return copySucceeded(key, name)
      copyRefused(key, result.value)
    } finally {
      setReading(null)
    }
  }

  return {
    unlocked,
    shown: (key) =>
      current?.key === key ? { value: current.value, fallback: current.fallback, remainingMs: current.at + REVEAL_MS - clock } : null,
    reading: (key) => (reading?.key === key ? reading.kind : null),
    busy: reading !== null,
    copied: (key) => copied === key,
    error: (key) => errors[key] ?? "",
    toggle,
    copy,
    closeFallback: () => setCurrent((before) => (before !== null && before.fallback ? null : before)),
  }
}

/**
 * The value cell: the value while it is on screen, with its countdown, a
 * refused copy's text selected, a refused read's reason, or `idle`, what the
 * row says when nothing shows. Never dots: a value comes back to nobody but
 * the owner, on demand.
 */
export function ValueCell({ table, rowKey, idle = null }: { table: ValueTable; rowKey: string; idle?: ReactNode }) {
  const shown = table.shown(rowKey)
  const error = table.error(rowKey)
  if (shown !== null && shown.fallback) return <CopyFallback text={shown.value} onClose={table.closeFallback} />
  if (shown !== null) {
    return (
      <span className="grid w-full min-w-0 gap-1 py-1.5">
        <code className="block max-h-24 overflow-y-auto rounded-md bg-sunk px-2 py-1 font-mono text-xs break-all text-foreground shadow-well select-all">
          {shown.value}
        </code>
        <span className="text-xs text-muted-foreground tabular-nums">{hideCountdown(shown.remainingMs)}</span>
      </span>
    )
  }
  if (error !== "") return <span className="text-xs text-pretty text-destructive">{error}</span>
  return <>{idle}</>
}

/** A row's actions that appear under the pointer and on focus, and stay while they are in use. */
export const ON_HOVER = "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"

/**
 * The owner's Reveal and Copy, as two icon buttons: under the pointer and
 * on focus, and in sight while the value shows, a read runs or a copy has
 * just succeeded.
 */
export function RevealButtons({ table, rowKey, name }: { table: ValueTable; rowKey: string; name: string }) {
  const shown = table.shown(rowKey) !== null
  const reading = table.reading(rowKey)
  const copied = table.copied(rowKey)
  const seconds = REVEAL_MS / 1000
  const locked = table.unlocked ? "" : ", asks to unlock first"
  const quiet = !shown && reading === null && !copied
  const style = cn("text-muted-foreground hover:text-foreground", quiet && ON_HOVER)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        title={shown ? "Hide value" : `Reveal for ${seconds} seconds`}
        aria-label={shown ? `Hide ${name}` : `Reveal ${name} for ${seconds} seconds${locked}`}
        aria-busy={reading === "reveal" || undefined}
        disabled={reading === "copy"}
        onClick={() => void table.toggle(rowKey, name)}
        className={style}
      >
        {reading === "reveal" ? <LoaderCircle className="motion-safe:animate-spin" /> : shown ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Copy value"
        aria-label={`Copy ${name}${locked}`}
        aria-busy={reading === "copy" || undefined}
        disabled={reading === "reveal"}
        onClick={() => void table.copy(rowKey, name)}
        className={style}
      >
        {reading === "copy" ? <LoaderCircle className="motion-safe:animate-spin" /> : copied ? <Check className="text-ok-text" /> : <Copy />}
      </Button>
    </>
  )
}

/** The same two, as the row menu's first items: the way to them on a phone, which has no pointer to hover with. */
export function RevealMenuItems({ table, rowKey, name }: { table: ValueTable; rowKey: string; name: string }) {
  const shown = table.shown(rowKey) !== null
  return (
    <>
      <DropdownMenuItem onClick={() => void table.toggle(rowKey, name)} className="h-9">
        {shown ? <EyeOff /> : <Eye />}
        {shown ? "Hide value" : "Reveal value"}
        {!table.unlocked && <LockGlyph className="ml-auto" />}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void table.copy(rowKey, name)} className="h-9">
        <Copy />
        Copy value
        {!table.unlocked && <LockGlyph className="ml-auto" />}
      </DropdownMenuItem>
    </>
  )
}
