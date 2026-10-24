/** The block's outline: two slits cut in from opposite sides, the S of sitesolide left standing in the material. */
const BLOCK =
  "M8.47 3H23.53A5.47 5.47 0 0 1 29 8.47V10.73H11.76A1.23 1.23 0 0 0 11.76 13.19H29V23.53A5.47 5.47 0 0 1 23.53 29H8.47A5.47 5.47 0 0 1 3 23.53V21.27H20.24A1.23 1.23 0 0 0 20.24 18.81H3V8.47A5.47 5.47 0 0 1 8.47 3Z"

/**
 * The mark, drawn as the landing page draws it: the block laid twice, its hard
 * shadow offset down and to the right, then its petrol face ringed with the
 * line. The slits are holes in both, so the page shows through them in both
 * themes. Its colours are the landing page's own, `mark-face`, `mark-line` and
 * `mark-shadow` in styles/global.css, rather than the dashboard's greys: the
 * logo is the brand's, the same on every surface that carries it.
 *
 * The portal's page and docs/assets draw it the same way. The favicon, in
 * layouts/main.astro, keeps a petrol gradient, as the landing page's does.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" overflow="visible" aria-hidden="true">
      <path d={BLOCK} transform="translate(1.6 1.6)" className="fill-mark-shadow" />
      <path d={BLOCK} className="fill-mark-face stroke-mark-line" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}
