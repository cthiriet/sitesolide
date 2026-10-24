import type { ReactNode } from "react"
import { ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** A link inside text, to a site or a page of the dashboard: underlined at rest, darker on hover. */
export const TEXT_LINK =
  "rounded-sm underline decoration-foreground/20 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"

/**
 * An address opens alongside, never in place of the dashboard: leaving it to
 * look at a site would cost the position in the list, and a reconnection if the
 * session had expired meanwhile.
 *
 * The underline is visible at rest: a link that is only recognised on hover is
 * not recognised on a touch screen. The arrow is inline, so it follows the last
 * word when the address wraps onto two lines. `rel` goes with `target`: without
 * `noopener`, the opened page keeps a reference to this one.
 */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(TEXT_LINK, "max-w-full transition-colors wrap-anywhere", className)}
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="ml-1 inline-block size-3 align-[-0.0625rem] text-muted-foreground" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
