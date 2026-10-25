# Brand assets

| File | Use |
|---|---|
| `logo-light.svg` | The logo on a light background: the README, documentation. Still the earlier drawing, see below. |
| `logo-dark.svg` | The same on a dark background, where the mark's line turns pale and its shadow lifts. Still the earlier drawing. |
| `mark.svg` | The mark alone, square, for an avatar or an icon, in its Ledger drawing. |
| `social-preview.png` | The repository's social card, 1280 × 640: the landing page's share card, its title and its command, with the repository's address. Still the look before Ledger, until it is taken again from the landing page's new card. GitHub does not read it from here: a new one is uploaded by hand under *Settings → Social preview*. |
| `screenshots/` | Screenshots, `dashboard.png` in the README: the real dashboard, run by its page bench in showcase mode (`BENCH_SHOWCASE=1 bun scripts/page-bench.ts` in `dashboard/`), with fictitious sites, and the door page rendered by `portal/src/page.ts`. Each is framed as the landing page frames its hero: in its window, an address in its bar, on its dawn landscape. `dashboard.png` is Sites at 1440 × 900, in a window 1200 wide; `audience.png`, `site.png` and `secrets.png` the content alone of wheels' Audience and of cms's Overview and Secrets, 1208 × 739, and `preview-lock.png` the door page at 1200 × 720, each in a window 1000 wide, the door page's at `bakery-martin.example.com`, the others' at `dashboard.example.com`; all at twice the density, in light. |

**The mark** is a solid block with two slits cut in from opposite sides: the S
of sitesolide, left standing in the material. The slits are holes rather than
bars painted over the block, so any background shows through them.

Its Ledger drawing is the block filling its square, a teal gradient from
`#14899a` at its top left corner to `#0a5560` at its bottom right, the same in
light and in dark. The landing page's header draws it so, and so do the
dashboard (`dashboard/web/src/components/logo.tsx`, its `mark-hi` and
`mark-lo` tokens), the portal's sign-in, the door page of locked previews and
the portal's own root (`portal/src/page.ts`), and `mark.svg`. The favicons of
all three are the same block, its gradient `#138896` to `#0a5560`, and
`#5cc8d3` to `#2c98a4` in a dark browser, where the deep end would sink into
the tab strip.

`logo-light.svg` and `logo-dark.svg` still carry the earlier drawing: the
block laid twice, a hard shadow offset by 1.6 down and to the right, then a
petrol face ringed with a line 1.5 wide, beside a wordmark in Archivo. Their
Ledger version waits for the wordmark: the landing page sets the name in
Hanken Grotesk at weight 600, tracked at -0.025 em, and the logo files need
it converted to outlines, so the SVG renders the same without the font. A
change goes to all of these files, and comes from the landing page first.

| Colour, earlier drawing | Light | Dark |
|---|---|---|
| Wordmark | `#16181d` | `#e7e9ec` |
| Mark's face | `#0b6e79` | `#0c6870` |
| Mark's line | `#12211f` | `#cfe3dc` |
| Mark's shadow | `#12211f` | `#4f7a70` |

**One colour family.** The mark's colours are the landing page's own, around
the accent, `#0b6e79`, so the logo and the accent read as the same teal. Red
is the dashboard's error colour, and the portal's, never the brand's. The
dashboard's tokens, `mark-hi`, `mark-lo`, `primary` and `foreground`, are in
`dashboard/web/src/styles/global.css`.
