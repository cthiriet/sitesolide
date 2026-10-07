import { useId } from "react"

/**
 * The mark: a solid block with two slits cut in from opposite sides, the S of
 * sitesolide left standing in the material. The landing page and the portal
 * carry the same outline, and docs/assets holds it as files.
 *
 * One path rather than a block under two lighter bars: the slits are holes, so
 * the page shows through them in both themes. The gradient is the brand's
 * petrol, `mark-from` to `mark-to` in styles/global.css, one step lighter and
 * one step deeper than the accent, lifted in the dark theme where the deep end
 * would sink into the page. Its id goes through useId: ids are global to the
 * document, and two logos rendered together would steal each other's gradient.
 */
export function Logo({ className }: { className?: string }) {
  const fill = `${useId()}-fill`

  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={fill} x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="[stop-color:var(--mark-from)]" />
          <stop offset="1" className="[stop-color:var(--mark-to)]" />
        </linearGradient>
      </defs>
      <path
        d="M8.47 3H23.53A5.47 5.47 0 0 1 29 8.47V10.73H11.76A1.23 1.23 0 0 0 11.76 13.19H29V23.53A5.47 5.47 0 0 1 23.53 29H8.47A5.47 5.47 0 0 1 3 23.53V21.27H20.24A1.23 1.23 0 0 0 20.24 18.81H3V8.47A5.47 5.47 0 0 1 8.47 3Z"
        fill={`url(#${fill})`}
      />
    </svg>
  )
}
