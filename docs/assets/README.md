# Brand assets

| File | Use |
|---|---|
| `logo-light.svg` | The logo on a light background: the README, documentation. |
| `logo-dark.svg` | The same on a dark background, where the mark's line turns pale and its shadow lifts, as on the landing page in dark. |
| `mark.svg` | The mark alone, square, for an avatar or an icon. |
| `social-preview.png` | The repository's social card, 1280 × 640: the landing page's share card, its title and its command, with the repository's address. GitHub does not read it from here: a new one is uploaded by hand under *Settings → Social preview*. |
| `screenshots/` | Screenshots, `dashboard.png` in the README: the real dashboard, run by its page bench in showcase mode (`BENCH_SHOWCASE=1 bun scripts/page-bench.ts` in `dashboard/`), with fictitious sites. `dashboard.png` and `audience.png` are framed as the landing page frames its hero: in its window, the address `dashboard.example.com` in its bar, on its dawn landscape. The dashboard is taken at 1440 × 900, Audience as its content alone, 1208 × 739, and the door page at 1200 × 720, all at twice the density, then set in a window 1200, 1000 and 1000 wide. The door page's still has the earlier frame, near black graphite lit by the brand's petrol. |

**The mark** is a solid block with two slits cut in from opposite sides: the S
of sitesolide, left standing in the material. The slits are holes rather than
bars painted over the block, so any background shows through them.

The landing page now draws it in its Ledger look: the block filling its
square, a teal gradient from `#14899a` at its top left corner to `#0a5560` at
its bottom right, as its favicon always did. The dashboard
(`dashboard/web/src/components/logo.tsx`) follows it. These files and the
portal's page (`portal/src/page.ts`) still carry the earlier drawing, the
block laid twice, a hard shadow offset by 1.6 down and to the right, then a
petrol face ringed with a line 1.5 wide, until they follow too; a change
goes to all of them, and comes from the landing page first. The favicons
keep the gradient, the block filling the whole square.

**The wordmark** is Archivo at width 125 and weight 650, tracked at −0.02 em,
converted to outlines so the SVG renders the same without the font. Its height,
baseline to ascender, is 52 % of the mark's, centred on it.

| Colour | Light | Dark |
|---|---|---|
| Wordmark | `#16181d` | `#e7e9ec` |
| Mark's face | `#0b6e79` | `#0c6870` |
| Mark's line | `#12211f` | `#cfe3dc` |
| Mark's shadow | `#12211f` | `#4f7a70` |
| Favicon | `#138896` → `#0a5560` | `#5cc8d3` → `#2c98a4` |

**One colour family.** The mark's colours are the landing page's own, around
the dashboard's accent, `#0b6e79`, so the logo and the accent read as the same
teal. Red is the dashboard's error colour, never the brand's. The dashboard's
tokens, `mark-hi`, `mark-lo`, `primary` and `foreground`, are in
`dashboard/web/src/styles/global.css`; the table above gives these files'
own, from the earlier drawing.
