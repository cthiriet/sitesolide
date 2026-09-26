import { useEffect, useId, useRef, type KeyboardEvent as FieldKeyEvent, type RefObject } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { searchShortcut } from "@/lib/search"
import { FILTERS, type SiteFilter } from "@/lib/sites"
import { cn } from "@/lib/utils"

/**
 * The site search field. `/` brings focus to it from anywhere in the page,
 * except while typing; Escape clears the field, then, with the field empty,
 * gives focus back to the element that had it before `/`.
 */
export function SearchField({
  field,
  value,
  onValue,
  className,
}: {
  field: RefObject<HTMLInputElement | null>
  value: string
  onValue: (value: string) => void
  className?: string
}) {
  const id = useId()
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const element = field.current
      // Under the sign-in overlay the page is `inert`: the field does not take focus there.
      if (element === null || element.closest("[inert]") !== null) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!searchShortcut(event, target)) return
      event.preventDefault()
      const active = document.activeElement
      previousFocus.current = active instanceof HTMLElement && active !== document.body ? active : null
      element.focus()
      element.select()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [field])

  function handleFieldKeyDown(event: FieldKeyEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return
    // Chrome already clears a `search` field on Escape, but without giving focus back: the page decides on its own.
    event.preventDefault()
    if (value !== "") return onValue("")
    const previous = previousFocus.current
    previousFocus.current = null
    if (previous !== null && previous.isConnected) previous.focus()
    else event.currentTarget.blur()
  }

  function clear() {
    onValue("")
    field.current?.focus()
  }

  return (
    <div role="search" className={cn("relative", className)}>
      <label htmlFor={id} className="sr-only">
        Search sites
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={field}
        id={id}
        type="search"
        value={value}
        onChange={(event) => onValue(event.target.value)}
        onKeyDown={handleFieldKeyDown}
        placeholder="Search sites"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-keyshortcuts="/"
        className="peer h-10 bg-card pr-9 pl-8 md:h-9 dark:bg-card [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value === "" ? (
        // A reminder for the mouse and the physical keyboard: not on a narrow screen, nor on a touch screen.
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 hidden h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground peer-focus:opacity-0 sm:pointer-fine:inline-flex"
        >
          /
        </kbd>
      ) : (
        <span className="absolute inset-y-0 right-1 flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            onClick={clear}
            className="rounded-sm text-muted-foreground hover:text-foreground max-md:size-8"
          >
            <X />
          </Button>
        </span>
      )}
    </div>
  )
}

/**
 * The inventory's filters, one at a time, each with the number of sites it
 * would keep under the current search. Toggle buttons rather than a radio
 * group: each one reads and is reached on its own, with the keyboard as with a
 * finger. The chosen filter takes the white surface of the current page.
 */
export function SiteFilterChips({
  value,
  counts,
  onValue,
}: {
  value: SiteFilter
  counts: Record<SiteFilter, number>
  onValue: (filter: SiteFilter) => void
}) {
  return (
    <div
      role="group"
      aria-label="Filter sites"
      className="grid w-full grid-cols-5 gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5 sm:inline-flex sm:w-auto"
    >
      {FILTERS.map((filter) => {
        const selected = filter.key === value
        return (
          <button
            key={filter.key}
            type="button"
            aria-pressed={selected}
            title={filter.description}
            onClick={() => onValue(filter.key)}
            className={cn(
              "inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-[0.8125rem] whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 sm:px-2.5 sm:text-sm",
              selected
                ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {filter.label}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{counts[filter.key]}</span>
          </button>
        )
      })}
    </div>
  )
}
