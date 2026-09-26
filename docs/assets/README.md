# Brand assets

| File | Use |
|---|---|
| `logo-light.svg` | The logo on a light background: the README, documentation. |
| `logo-dark.svg` | The same on a dark background, where the lower strata are lightened so the last one does not sink into the page. |
| `mark.svg` | The mark alone, square, for an avatar or an icon. |
| `social-preview.png` | The repository's social card, 1280 × 640, set under *Settings → Social preview*. |
| `screenshots/` | The README's screenshots: the real dashboard, run by its page bench in showcase mode (`BENCH_SHOWCASE=1 bun scripts/page-bench.ts` in `dashboard/`), with fictitious sites, framed on the brand's midnight blue. |

**The mark** is the dashboard's: three stacked strata, one machine carrying
every site, the top one in the seal red. Its source of truth is
`dashboard/web/src/components/logo.tsx`; a change there comes here too.

**The wordmark** is Archivo at width 125 and weight 650, tracked at −0.02 em,
converted to outlines so the SVG renders the same without the font. Its height,
baseline to ascender, is 52 % of the mark's, centred on it.

| Colour | Light | Dark |
|---|---|---|
| Wordmark | `#0e1726` | `#e6eaf1` |
| Top stratum | `#e8556b` → `#a51f3a` | `#f06b81` → `#c22f4b` |
