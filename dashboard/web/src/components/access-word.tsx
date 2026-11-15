import { ArrowUpRight, Check, Copy, KeyRound } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { CopyFallback, useCopy } from "@/components/copy"
import { cn } from "@/lib/utils"

/** The landing page's chip: 20 px, the hairline, the cell's surface, a 12 px word. */
export const CHIP = "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border bg-cell px-1.5 text-xs font-medium whitespace-nowrap"

/**
 * An email that breaks right after its @ when the line is too narrow,
 * rather than at any letter: `alice@` then `example.com`.
 */
export function Who({ value }: { value: string }) {
  const at = value.indexOf("@")
  if (at <= 0 || at === value.length - 1) return <>{value}</>
  return (
    <>
      {value.slice(0, at + 1)}
      <wbr />
      {value.slice(at + 1)}
    </>
  )
}

/**
 * The preview code and its two actions: copy the link to send to the client, or
 * open it. The link carries the key as a parameter, which sets the cookie and
 * unlocks. `large` for the site card and for fingers: 36 px buttons.
 */
export function CodeChip({
  slug,
  code,
  url,
  large = false,
}: {
  slug: string
  code: string
  url: string | null
  large?: boolean
}) {
  const { state, copy, reset } = useCopy("Preview link copied")
  if (state === "failure" && url !== null) return <CopyFallback text={url} onClose={reset} />

  // 36 px for fingers and on the card; 24 px in the table's narrow column, for the mouse.
  const buttonSize = large ? "icon-lg" : "icon-xs"
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-md bg-sunk pl-2 whitespace-nowrap shadow-well",
        large ? "py-0.5 pr-0.5" : "pr-0.5",
      )}
    >
      <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Preview code </span>
      <code className={cn("mr-1 ml-1.5 font-mono font-medium tracking-[0.12em]", large ? "text-sm" : "text-xs")}>{code}</code>
      {url !== null && (
        <>
          <Button
            variant="ghost"
            size={buttonSize}
            title="Copy preview link"
            aria-label={`Copy preview link for ${slug}`}
            onClick={() => void copy(url)}
            className="rounded-sm text-muted-foreground hover:text-foreground"
          >
            {state === "copied" ? <Check className="text-ok-text" /> : <Copy />}
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open preview"
            className={cn(
              buttonVariants({ variant: "ghost", size: buttonSize }),
              "rounded-sm text-muted-foreground hover:text-foreground",
            )}
          >
            <ArrowUpRight aria-hidden="true" />
            <span className="sr-only">Open preview of {slug} (opens in a new tab)</span>
          </a>
        </>
      )}
    </span>
  )
}
