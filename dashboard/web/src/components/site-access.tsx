import { ArrowUpRight, Check, Copy, KeyRound, ShieldCheck } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { CopyFallback, useCopy } from "@/components/copy"
import { Status } from "@/components/page"
import { siteAccess } from "@/lib/sites"
import type { Site } from "@/lib/types"
import { cn } from "@/lib/utils"

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
        "inline-flex max-w-full items-center gap-0.5 rounded-sm border bg-muted/40 pl-2 whitespace-nowrap",
        large ? "py-0.5 pr-0.5" : "pr-0.5",
      )}
    >
      <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Preview lock code </span>
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

const NO_GATE = "Neither a preview lock nor the portal"

/**
 * How the site is closed, if it is, in an inventory row. A disagreement between
 * the manifest and what is running is said in red, and spelled out in the
 * discrepancies and on the card.
 */
export function Gate({ site, large = false }: { site: Pick<Site, "slug" | "portal" | "lock">; large?: boolean }) {
  const access = siteAccess(site)
  switch (access.kind) {
    case "code":
      return <CodeChip slug={site.slug} code={access.code} url={access.url} large={large} />
    case "portal":
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <ShieldCheck aria-hidden="true" className="size-3.5 text-muted-foreground" />
          Portal
        </span>
      )
    case "open":
      return (
        <span className="whitespace-nowrap text-muted-foreground" title={NO_GATE}>
          No gate
        </span>
      )
    case "mismatch":
      return (
        <Status tone="error" className="whitespace-normal">
          {access.label}
        </Status>
      )
  }
}
