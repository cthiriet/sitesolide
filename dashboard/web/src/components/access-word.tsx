import type { ReactNode } from "react"
import { ArrowUpRight, Check, Copy, Globe, KeyRound, Lock, type LucideIcon } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { CopyFallback, useCopy } from "@/components/copy"
import { Status } from "@/components/page"
import { siteAccess } from "@/lib/sites"
import type { AccessRole, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/** How far up the ladder each role stands, from Can open to Admin. */
const RUNG: Record<AccessRole, number> = { visitor: 1, viewer: 2, developer: 3, admin: 4 }

/**
 * A role as the landing page draws it: four bars rising, as many lit in the
 * share feature's ink as the role has rungs, the rest faint. It says the
 * height of the role at a glance; the word beside it says which.
 */
export function RoleBars({ role, muted = false, className }: { role: AccessRole; muted?: boolean; className?: string }) {
  const lit = RUNG[role]
  return (
    <svg aria-hidden="true" viewBox="0 0 15 11" className={cn("h-[11px] w-[15px] shrink-0", className)}>
      {[5, 7, 9, 11].map((height, index) => (
        <rect
          key={height}
          x={index * 4}
          y={11 - height}
          width="3"
          height={height}
          rx="0.5"
          className={index < lit && !muted ? "fill-share-ink" : "fill-share-ink/22"}
        />
      ))}
    </svg>
  )
}

/** The landing page's chip: 20 px, the hairline, the cell's surface, a 12 px word. */
export const CHIP = "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border bg-cell px-1.5 text-xs font-medium whitespace-nowrap"

/** A general access as a chip, with its glyph: the landing page's access badges. */
function AccessChip({ icon: Icon, title, className, children }: { icon: LucideIcon; title?: string; className?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn(CHIP, "h-6 px-2", className)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.25} />
      {children}
    </span>
  )
}

/**
 * An email, or a `@domain`, that breaks right after its @ when the line is
 * too narrow, rather than at any letter: `alice@` then `example.com`.
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

const PUBLIC = "Anyone with the address can open the site"

/**
 * A site's general access, in an inventory row. A disagreement between the
 * manifest and what is running is said in red, and spelled out in the
 * discrepancies and on the site's Overview.
 */
export function AccessWord({ site, large = false }: { site: Pick<Site, "slug" | "portal" | "lock">; large?: boolean }) {
  const access = siteAccess(site)
  switch (access.kind) {
    case "code":
      return (
        <span className="grid justify-items-start gap-1.5">
          <AccessChip icon={KeyRound} className="text-secondary-foreground">
            Anyone with the code
          </AccessChip>
          {access.code !== null && <CodeChip slug={site.slug} code={access.code} url={access.url} large={large} />}
        </span>
      )
    case "portal":
      return (
        <AccessChip icon={Lock} className="text-foreground">
          Restricted
        </AccessChip>
      )
    case "open":
      return (
        <AccessChip icon={Globe} title={PUBLIC} className="text-muted-foreground">
          Public
        </AccessChip>
      )
    case "mismatch":
      return (
        <Status tone="error" className="whitespace-normal">
          {access.label}
        </Status>
      )
  }
}
