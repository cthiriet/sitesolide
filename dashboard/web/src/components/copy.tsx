import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { copyShortcut } from "@/lib/signin"

type Announcer = (message: string) => void

const AnnounceContext = createContext<Announcer>(() => {})

/**
 * One single `aria-live` region for the whole page: copies, creations and
 * revocations are announced there. One region per button would be read in a
 * burst, and a region mounted at the same time as its text often is not read at
 * all.
 *
 * Nothing written there contains a password.
 */
export function Announcements({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("")
  const timer = useRef<number | undefined>(undefined)

  const announce = useCallback((text: string) => {
    // Empty it first: the same message twice in a row would not change the
    // region's contents, and would not be read out again.
    setMessage("")
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(text), 60)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {message}
      </div>
    </AnnounceContext.Provider>
  )
}

export function useAnnounce(): Announcer {
  return useContext(AnnounceContext)
}

/** The visual feedback of a successful copy lasts two seconds. */
const FEEDBACK_MS = 2000

/**
 * Copy to the clipboard, announce it, and say what to do if the browser
 * refuses: without a secure context, or without permission, `writeText`
 * rejects, and a button that does nothing without a word is worse than no
 * button.
 */
export function useCopy(announcement: string) {
  const announce = useAnnounce()
  const [state, setCopyState] = useState<"repos" | "copied" | "failure">("repos")
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      window.clearTimeout(timer.current)
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        setCopyState("failure")
        announce(`Couldn't copy automatically. Press ${copyShortcut(navigator.userAgent)} to copy the selected text.`)
        return false
      }
      setCopyState("copied")
      announce(announcement)
      timer.current = window.setTimeout(() => setCopyState("repos"), FEEDBACK_MS)
      return true
    },
    [announcement, announce],
  )

  const reset = useCallback(() => setCopyState("repos"), [])

  return { state, copy, reset }
}

/**
 * The fallback for a refused copy: the text, already selected, in a read-only
 * field. It closes on losing focus or on Escape.
 */
export function CopyFallback({ text, lines = 1, onClose }: { text: string; lines?: number; onClose: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [shortcut, setShortcut] = useState("Ctrl+C")

  useEffect(() => {
    setShortcut(copyShortcut(navigator.userAgent))
    field.current?.focus()
    field.current?.select()
  }, [])

  return (
    <div className="grid w-full min-w-0 gap-1">
      <textarea
        ref={field}
        readOnly
        rows={lines}
        wrap={lines === 1 ? "off" : "soft"}
        value={text}
        aria-label="Text to copy"
        onBlur={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
        className="w-full min-w-0 resize-none rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <span className="text-xs text-muted-foreground">Press {shortcut} to copy.</span>
    </div>
  )
}

/** A command to run in a terminal, to be copied as it is. */
export function Command({ text, label = "Copy command" }: { text: string; label?: string }) {
  const { state, copy, reset } = useCopy("Command copied")
  if (state === "failure") return <CopyFallback text={text} onClose={reset} />
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-sm bg-muted py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{text}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        onClick={() => void copy(text)}
        className="text-muted-foreground hover:text-foreground max-md:size-10"
      >
        {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
      </Button>
    </div>
  )
}
