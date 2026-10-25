# Brand assets

| File | Use |
|---|---|
| `logo-light.svg` | The logo on a light background: the README, documentation. The mark and the name, as the landing page's header draws them. |
| `logo-dark.svg` | The same on a dark background, where the name turns pale; the mark does not change. |
| `mark.svg` | The mark alone, square, for an avatar or an icon. |
| `social-preview.png` | The repository's social card, 1280 × 640: the landing page's share card, its title and its command, with the repository's address in place of the site's. GitHub does not read it from here: a new one is uploaded by hand under *Settings → Social preview*. |
| `screenshots/` | Screenshots, `dashboard.png` in the README, described below. |

**The mark** is a solid block with two slits cut in from opposite sides: the S
of sitesolide, left standing in the material. The slits are holes rather than
bars painted over the block, so any background shows through them.

The block fills its square, a teal gradient from `#14899a` at its top left
corner to `#0a5560` at its bottom right, the same in light and in dark. The
landing page's header draws it so, and so do the dashboard
(`dashboard/web/src/components/logo.tsx`, its `mark-hi` and `mark-lo`
tokens), the portal's sign-in, the door page of locked previews and the
portal's own root (`portal/src/page.ts`), `mark.svg` and both logo files. The
favicons of all three are the same block, its gradient `#138896` to
`#0a5560`, and `#5cc8d3` to `#2c98a4` in a dark browser, where the deep end
would sink into the tab strip.

**The wordmark** is the name in Hanken Grotesk, the landing page's face, at
weight 600, tracked at -0.025 em. The logo files lay it out as the landing
page's header does (`.brand`), in its pixels: the mark 26 px square, 10 px
between them, the name at 19 px with its baseline 19 px below the mark's top.
Their `viewBox` is that header, 113.01 × 26, closed on the right by the
mark's own margin, a 32nd of its box; their intrinsic size is twice that.

The name is **converted to outlines**, so the SVG renders the same without the
font: HarfBuzz shapes it from the variable font the landing page serves, at
weight 600 with the font's kerning and no ligature, the letter spacing added
after each glyph as a browser adds it, and the glyphs' outlines are drawn at
that weight into one path, in font units, placed by a `translate` and a
`scale` of 19/1000. Rendered where the header draws its brand and compared at
twice the density, the files carry the same ink as the site's header within
0.3 %, their centroid within 0.05 device pixel, in light and in dark. A change
goes to all of these files, and comes from the landing page first.

| Colour | Light | Dark |
|---|---|---|
| Wordmark | `#141816` | `#e8edea` |
| Mark | `#14899a` to `#0a5560` | the same |

The wordmark's colours are the landing page's `--ink`, in light and in dark,
which are the dashboard's `foreground`.

**One colour family.** The mark's colours are the landing page's own, around
the accent, `#0b6e79`, so the logo and the accent read as the same teal. Red
is the dashboard's error colour, and the portal's, never the brand's. The
dashboard's tokens, `mark-hi`, `mark-lo`, `primary` and `foreground`, are in
`dashboard/web/src/styles/global.css`.

**The screenshots** are the real dashboard, run by its page bench in showcase
mode, with fictitious sites, and the real door page:

```bash
cd dashboard && SITESOLIDE_BUILD_VERSION=$(git describe --tags --abbrev=0) bun run build
BENCH_SHOWCASE=1 bun scripts/page-bench.ts   # password: demo
```

The build is handed the release the tree is at: the assets being retaken
leave the tree dirty, and the sidebar would say so. The door page is the HTML
`doorPage` in `portal/src/page.ts` writes, its contact `hello@example.com`.
Each page is taken by the workstation's Chrome, driven by Playwright, at twice
the density, in light, the clock in UTC:

| File | What | Taken at | Window |
|---|---|---|---|
| `dashboard.png` | Sites | 1440 × 900 | 1200 wide, `dashboard.example.com` |
| `tokens.png` | Tokens, Release agent's sheet open | 1440 × 900 | 1200 wide, `dashboard.example.com` |
| `access.png` | cms's Access, the content alone | 1208 × 739 | 1000 wide, `dashboard.example.com` |
| `preview-lock.png` | The door page | 1200 × 720 | 1000 wide, `bakery-martin.example.com` |

Each is framed as the landing page frames its hero: in its window, an address
in its bar, on its dawn landscape, 1312 × 902 for a window 1200 wide and
1088 × 728 for one 1000 wide. The landscape is drawn without its grain, as the
share card draws it: the noise tripled every file's weight, and does not show
at the size a README displays them. The files are then recompressed
losslessly with oxipng. The scripts that take, frame and compress them, and the
one that converts the name to outlines, are the workstation's, not kept here:
they need Playwright, HarfBuzz, fontTools and oxipng, which nothing in this
repository depends on.

**The social card** is the landing page's share card redrawn at GitHub's
1280 × 640, at one pixel per pixel: the same landscape without grain, the
mark and its name, the hero's title with its serif accent, and the deploy
command in a terminal well, set in the site's own fonts; the address under it
is `github.com/cthiriet/sitesolide`.
