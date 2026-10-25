import { useId } from "react"

/** The block's outline: two slits cut in from opposite sides, the S of sitesolide left standing in the material. */
const BLOCK =
  "M7.32 1H24.68A6.32 6.32 0 0 1 31 7.32V9.92H11.11A1.42 1.42 0 0 0 11.11 12.76H31V24.68A6.32 6.32 0 0 1 24.68 31H7.32A6.32 6.32 0 0 1 1 24.68V22.08H20.89A1.42 1.42 0 0 0 20.89 19.24H1V7.32A6.32 6.32 0 0 1 7.32 1Z"

/**
 * The mark, drawn as the landing page draws it: the block filling its square,
 * a teal gradient from its top left corner to its bottom right, `mark-hi` to
 * `mark-lo` in styles/global.css. The slits are holes, so the page shows
 * through them in both themes. The gradient's id is the instance's own: two
 * marks on a page, the sidebar's and the header's, must not share one.
 *
 * The favicon, in layouts/main.astro, is the same block, and the landing
 * page's and the portal's favicon byte for byte: a gradient of its own, a
 * lighter one in a dark browser, where this one's deep end would sink into
 * the tab strip.
 */
export function Logo({ className }: { className?: string }) {
  const gradient = `mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="[stop-color:var(--mark-hi)]" />
          <stop offset="1" className="[stop-color:var(--mark-lo)]" />
        </linearGradient>
      </defs>
      <path d={BLOCK} fill={`url(#${gradient})`} />
    </svg>
  )
}
