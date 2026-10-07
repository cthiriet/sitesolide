# Brand assets

| File | Use |
|---|---|
| `logo-light.svg` | The logo on a light background: the README, documentation. |
| `logo-dark.svg` | The same on a dark background, where the mark's petrol is lifted so its deep end does not sink into the page. |
| `mark.svg` | The mark alone, square, for an avatar or an icon. |
| `social-preview.png` | The repository's social card, 1280 × 640, set under *Settings → Social preview*. |
| `screenshots/` | Screenshots, `dashboard.png` in the README: the real dashboard, run by its page bench in showcase mode (`BENCH_SHOWCASE=1 bun scripts/page-bench.ts` in `dashboard/`), with fictitious sites, framed on near black graphite lit by the brand's petrol. |

**The mark** is a solid block with two slits cut in from opposite sides: the S
of sitesolide, left standing in the material. The slits are holes rather than
bars painted over the block, so any background shows through them. Its source
of truth is `dashboard/web/src/components/logo.tsx`; a change there comes here
too, and to the portal's page and the dashboard's favicon.

**The wordmark** is Archivo at width 125 and weight 650, tracked at −0.02 em,
converted to outlines so the SVG renders the same without the font. Its height,
baseline to ascender, is 52 % of the mark's, centred on it.

| Colour | Light | Dark |
|---|---|---|
| Wordmark | `#16181d` | `#e7e9ec` |
| Mark | `#138896` → `#0a5560` | `#5cc8d3` → `#2c98a4` |

**One colour family.** The mark's gradient runs one step either side of the
dashboard's accent, `#0b6e79` in light and `#4cb8c4` in dark, so the logo and
the accent read as the same petrol; the wordmark takes the dashboard's text
colour. Red is the dashboard's error colour, never the brand's. The tokens
behind these values, `mark-from`, `mark-to`, `primary` and `foreground`, are in
`dashboard/web/src/styles/global.css`.
