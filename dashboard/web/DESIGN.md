# Dashboard design

This document is the reference for the page: its tokens, its primitives, its
words and its layout rules. It describes what is built, not an intention. The
architecture (service, steward, portal, deployment) is in
[`../README.md`](../README.md). The components live in `src/components/`, what
they decide in `src/lib/`, tested by `tests/`.

Everything in English: interface text, comments, identifiers. No em dash or
en dash anywhere. See the rule in [`../../CLAUDE.md`](../../CLAUDE.md).

## 1. The subject, and the stance

One operator, one machine serving every project. They open the dashboard several
times a day, often for a few seconds, on a computer and on a phone, in light
during the day and dark in the evening. The page answers one question first:
**is the machine all right, and if not, which site should I look at?** Then,
once inside a site: **what makes it run, who gets in, and what needs changing?**

The look is **Ledger**, the landing page's, so that someone who has just left
it recognises the same product: a mineral paper leaning to the teal, panels a
step above it ringed with a hairline and lifted by a soft shadow, wells sunk
below their surface, Hanken Grotesk for the words and IBM Plex Mono for the
machine's, and one accent, a deep teal, which is the brand's: the logo is a
teal gradient, and the accent marks what is current or in focus and the one
primary action, pressable like a key. Red is the error colour, not the
brand's, and it only says error. The only remarkable piece is **the machine
plate** at the top of the home page, where the 70 and 90 % thresholds are
ticked on each gauge. Everything else is calm, dense and aligned.

The owner's attention is the scarce thing. A page that shows everything at
equal weight pulls it everywhere at once; these rules decide what a page
shows, and what waits one gesture away.

1. **The verdict first.** Every page carries, in the same place, the machine's
   verdict and the age of the data. A stale snapshot never says "All clear".
2. **One primary object per page.** A page shows its list or its object, and
   nothing of equal weight beside it. Its history lives in Activity, reached
   by the quiet *History* link of its header, narrowed to it (3.3); a page
   never carries an activity panel of its own.
3. **One line per item.** Rows of 44 px on a computer, 40 for Activity and
   Backups; two lines of 56 to 60 px below the width the row needs, decided
   by the list's own width. Name first, at most four short columns, machine
   strings in muted mono, numbers right-aligned and tabular.
4. **Quiet when fine, loud when not.** A healthy row says nothing: no
   *Running*, no *Active*, no green dot. A row in trouble carries the
   severity icon in its 28 px gutter and a short word in its tone. The
   verdict says *All clear* once for the page.
5. **Details on demand.** A secondary fact goes to the detail sheet, a
   tooltip, the row menu, or a disclosure that shows its count ("Build and
   public names (5)"), never into the row. The count says what is folded, so
   folding costs no trust.
6. **One action in the row at most**, and only when it is the page's job:
   *Set* a missing secret, *Grant* a request, *Restore* on hover. Everything
   else is in the row menu, destructive last under a separator, still
   confirmed.
7. **Icons that mean one thing everywhere** (5, *Icons*), 16 px in a row,
   muted unless they carry a state. The facet menus show the same icons
   beside their words, so they are the legend.
8. **Empty is small.** Inside a panel, one 44 px line: an icon, the state,
   one action. A section with nothing in it and nothing to ask disappears.
   The tiled empty state is for a page with nothing at all.
9. **A write says what it does, and asks for the unlock just in time.** No
   *Unlock changes* button, no *Unlock to ...*: a write is *New token*,
   *Add*, *Restore*, with a small lock glyph while locked; pressed, it asks
   for the password, then performs.
10. **Counts agree.** The sidebar's badge, the verdict, the header's count and
    the rows count the same things.
11. **Red means error, and nothing else.** Neither a link, nor the current
    page, nor a focus ring is red. **Teal means "here"**: the current page,
    the focused element, a gauge's fill, the primary button; never a state.
12. **Structure carries information.** A hairline separates the rows of a
    list, a panel groups what is read together, a tick on a gauge marks a
    threshold, a tile labels what it sits beside. No decorative frames,
    numbers or labels; panels, not stacked cards.
13. **Nothing moves without a reason.** No entrance animation; only what
    answers a gesture moves, and nothing under `prefers-reduced-motion`.

## 2. Tokens

All in `src/styles/global.css`, under `:root` (light) and `.dark`. A component
**never** writes a hex value or a Tailwind palette colour (`amber-500`,
`emerald-700`): it names a token. The values are the landing page's own, its
system's `--bg`, `--card`, `--raised`, `--bg-sunk`, `--line`, `--ink` and the
rest, under the names shadcn's components read.

### 2.1 Colours

| Token (class) | Light | Dark | Role |
|---|---|---|---|
| `background` | `#f4f5f1` | `#0d1211` | the paper: the page, the sidebar, the sticky header |
| `card` | `#fbfbf9` | `#141a19` | a panel, a step above the paper |
| `popover` | `#ffffff` | `#1c2422` | the raised surface: a menu, a dialog, a tooltip's, a chosen segment, the top of a secondary button |
| `sunk` | `#eceee8` | `#0c1110` | a well below its surface: a field, a command, a code, a segmented control's frame |
| `cell` | `#f7f8f4` | `#111716` | a band or a chip: a table's head, a dialog's foot, a counter, a tag, inline code |
| `tile` | `#eceee8` | `#151c1a` | an icon's tile |
| `foreground` | `#141816` | `#e8edea` | text |
| `strong` | `#0b0e0d` | `#f7f9f8` | what is current or chosen: the sidebar's page, a selected filter, a site's name |
| `secondary-foreground` | `#3a413d` | `#c4ccc7` | text a step below the body: navigation, the filters not chosen, a counter |
| `muted-foreground` | `#636862` | `#949e99` | meta, help text, a mono label |
| `faint` | `#9ea39c` | `#5f6964` | a neutral dot, a role's unlit bars |
| `muted`, `secondary`, `accent` | `#e7e9e2` | `#222b29`, `#222b29`, `#252f2c` | a hover, the neutral pill, a skeleton; a step past `sunk` and `popover`, so that a hover shows inside a well and in a dialog; `accent` a menu item's highlight |
| `border` | `#e2e3dc` | `#232c2a` | the hairline: a panel's frame, a header's rule, a chip's edge |
| `divider` | `#e9eae4` | `#1c2422` | the rule between two rows of a list or a table |
| `input` | `#d3d6ce` | `#303b38` | a field's edge, a secondary button's |
| `primary`, `ring` | `#0b6e79` | `#3fa6ae` | the accent: the focus ring, the current page's icon, a gauge's fill |
| `primary-hi`, `primary-lo`, `primary-edge` | `#12838f`, `#0a616b`, `#07484f` | `#148e9a`, `#0b6670`, `#04363b` | the primary button: its gradient, top to bottom, and its edge |
| `primary-foreground` | `#ffffff` | `#ffffff` | the primary button's label |
| `link` | `#0a6570` | `#74c6c6` | the accent as text |
| `highlight`, `highlight-line` | `#e3edeb`, `#c2d7d4` | `#112828`, `#1e4647` | the accent's palest tint and its hairline: the current page, the chosen way a site opens, a ticked choice |
| `mark-hi`, `mark-lo` | `#14899a`, `#0a5560` | the same | the logo's gradient |
| `track`, `tick` | `#e2e3dc`, `#8b9089` | `#0c1110`, `#66706b` | a gauge's empty bar, its threshold ticks |
| `destructive` | `#ae4029` | `#f0896d` | errors, and only errors |
| `share-tint`, `share-ink` | `#e9e4f2`, `#654e99` | `#211c33`, `#b9a6ea` | the share feature: a role's bars |
| `signin-tint`, `signin-ink` | `#e0e8f3`, `#2d5a96` | `#15233a`, `#91b4ea` | the sign-in feature: the provider's button |
| `recover-tint`, `recover-ink` | `#deede2`, `#2c7247` | `#13291d`, `#7fc99c` | the recover feature, for a tile of the backups' own |
| `sidebar-accent`, `sidebar-primary` | as `muted`, `primary` | as `muted`, `primary` | a hover in the sidebar, and the current page's icon |

**The brand is one teal**: `highlight`, the palest, for a surface that says
"here", `primary` the accent, and its three steps for the button that is
pressed. Dark lifts the accent and turns the tint into a deep teal surface.

**The landing page's features**, a tint and its ink each, come in three, and
only for what is that feature's own and no larger than a chip or a 40 px
tile: share, the violet of a role's bars; sign-in, the blue of the provider's
button; recover, the green of a backup. Its two others stay out of the page:
its coral, monitor, would read as an error, and its amber, run, as a warning,
and here red means error and amber attention, nothing else.

**The logo is the landing page's**, drawn as its header draws it: the block
filling its square, a gradient from `mark-hi` at its top left corner to
`mark-lo` at its bottom right, the same in both themes. The favicon is the
same block, with a lighter gradient in a dark browser, `#5cc8d3` to `#2c98a4`,
since the deep end would sink into a dark tab strip.

Measured contrasts (WCAG), to check again after any change. Light:
`foreground` 17.3:1 on `card`; `secondary-foreground` 10.1:1 on `card`;
`muted-foreground` 5.5:1 on `card`, 5.2:1 on `background`, 4.6:1 on `muted`
and 4.8:1 on `highlight`; white on `primary` 6.0:1 and on the button's
gradient 4.5 to 7.2:1; `primary` as a ring, a marker or a fill 5.8:1 on
`card`, 4.9:1 on `muted` and 4.6:1 on the track; `link` 6.5:1 on `card`;
`destructive` 5.7:1 on `card`; a tick 3.1:1 on `card`. Dark: `foreground`
14.9:1 on `card`; `muted-foreground` 6.4:1 on `card` and 5.7:1 on `popover`;
white on the button's gradient 3.9 to 6.7:1; `primary` 6.1:1 on `card` and
6.6:1 on the track; `destructive` 7.1:1 on `card`; a tick 3.4:1 on `card`
and 3.1:1 on `popover`. On `highlight`: `strong` 16.2:1 in light and 14.6:1
in dark, `primary` 5.0 and 5.4:1. The full list is in the comment of
`styles/global.css`.

The portal's visitor pages (`portal/src/page.ts`) carry the same values in
their own inline CSS, the moved ones below included, so that a visitor's
sign-in and the owner's share one red, one muted grey and one field.

Four values move from the landing page to clear those floors: its muted
`#6a6f69` (4.2:1 on `muted`) became `#636862`, its down red `#c24e33` (4.3:1
on its pill) became `#ae4029`, and the ticks, which the landing page has
none of, took `#8b9089` and `#66706b`. One pair stays short, at the top of a
gradient: white on `primary-hi` in dark, 3.9:1, where the label sits on the
gradient's middle, 5.0:1.

### 2.2 Status tones

Four tones, not one more, from the `Tone` type in `lib/tones.ts`. Their classes
are spelled out there (`TONE_DOT`, `TONE_HALO`, `TONE_TEXT`, `TONE_PILL`,
`TONE_BADGE`, `TONE_BANNER`), and `tests/tones.test.ts` checks that they only
name tokens.

| Tone | Dot (solid) | Text | Light, dot and text | Dark, dot and text | Meaning |
|---|---|---|---|---|---|
| `ok` | `bg-ok` | `text-ok-text` | `#2c8a57`, `#2c7247` | `#6cc98f`, `#7fc99c` | running, up to date |
| `attention` | `bg-attention` | `text-attention-text` | `#b26a0c`, `#8c580b` | `#e5ae64` | worth a look: 70 % threshold, restart pending, expiry near |
| `error` | `bg-destructive` | `text-destructive` | `#ae4029` | `#f0896d` | to deal with: service not running, general access in disagreement, 90 % threshold |
| `neutral` | `bg-faint` | `text-muted-foreground` | `#9ea39c`, `#636862` | `#5f6964`, `#949e99` | information, without judgement |

A status is the landing page's: an 8 px dot ringed by a halo of its own
colour at about a sixth (`TONE_HALO`), then its word; a pill, for what has to
be seen from afar, is a 24 px chip with its tone's hairline and tint. A count
over an icon or beside a navigation entry sits on a solid badge
(`TONE_BADGE`), the text tone's fill under the card's colour, which reads
whatever lies below it, the current page's tint included.

Each tone's text clears 4.5:1 on its tinted pill, in both themes: in light
`ok-text` 4.7:1, `attention-text` 4.7:1 and `destructive` 4.8:1 over
`background` (5.0, 5.0 and 5.1:1 over `card`); in dark beyond 5.9:1. A count
on its badge clears 5.6:1 in light and 7.1:1 in dark. Every dot but the
neutral one clears 3:1 on `card` and on `background`, and the attention fill
3:1 on the track; the neutral dot is faint on purpose, its word saying all
there is. `severityTone` gives a discrepancy's tone, `verdictTone` the
verdict's (a stale snapshot is an error).

**Quiet when fine.** One health state per object, and the fine one is not
drawn: no word, no dot, nothing in the gutter. Fine is said once per page,
by the verdict. Anything not fine always has its word in its tone
(`StateLabel`), and in a list its severity icon in the gutter
(`SeverityGutter`), with text for screen readers: colour still never carries
meaning alone, since every state that is drawn comes with its word. A
neutral word, information without judgement ("Not declared", "Unknown"),
stays muted. A pill (`Status shape="pill"`) is for what has to be seen from
afar: the verdict, the unlocked pill.

### 2.3 Typography

**Hanken Grotesk** (`@fontsource-variable/hanken-grotesk`) for every word,
titles included, and **IBM Plex Mono** (`@fontsource/ibm-plex-mono`, 400 and
500) **for every machine string**: an address, a port, a version, a path, a
unit, a variable or file name, a lock code, a command, a dotted action, an
audit's raw fields; and for the labels. Both are served from `_assets/`, with
no third-party request. A slug is a name and stays in Hanken, as are an email
and a number; a key in a `kbd` is not monospace either. Hanken's figures are
tabular by default, so numbers that get compared line up.

| Role | Classes |
|---|---|
| Page title (`h1`) | `text-title` (22/28 px, 500, -0.025 em) |
| Gauge figure, audience figure | `text-figure` (26/32 px, 500, -0.03 em) |
| Panel title (`h2`) | `text-heading` (15/20 px, 600, -0.01 em) |
| Dialog title | `text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]` (17/24 px, the landing page's card titles) |
| Body text, cells | `text-sm` (14/20 px) |
| Meta, help | `text-xs text-muted-foreground` (12 px) |
| Label: a column head, a gauge's heading, a panel's unit, a menu's group | `mono-label` (Plex Mono 11/16 px, 500, capitals, +0.12 em, `muted-foreground`; 12 px on a phone) |
| An address | `font-mono text-[0.8125rem]` (13 px) |
| A name, a path, a unit in a row | `font-mono text-xs` (12 px) |
| A dotted action, a variable in a sentence, the version | `font-mono text-[0.6875rem] max-md:text-xs` (11 px, 12 on a phone) |
| Wordmark in the sidebar | `text-[0.9375rem] font-semibold tracking-[-0.02em]`, the zone below in `font-mono text-xs text-muted-foreground` |

`text-title`, `text-figure` and `text-heading` are theme tokens, and
`mono-label` a utility, in `styles/global.css`. Capitals and letter spacing
only in a `mono-label` and a lock code, no single word in a different colour
inside a title, nothing below 11 px, and nothing that carries meaning below
12 px on a phone. A chart's figures and dates are text in the page beside its
SVG, never text inside it: in the viewBox they would scale with the panel,
from some 6 px on a phone to 16 px on a wide screen.

### 2.4 Spacing, widths, radii, surfaces

- 4 px base. Page gutter `px-4`, then `md:px-8`.
- Content in `max-w-6xl` (1152 px), centred to the right of the sidebar.
- Between two blocks of a page, `gap-6`. Inside a panel, rows `px-4 py-2.5`
  (dense list) or `py-3` (two-level row, and every table row).
- Bottom padding `pb-28` on a phone, to clear the tabs.
- Radii in whole pixels, concentric: the more containing the object, the
  larger its radius. Plate, panel, table, menu and dialog `rounded-xl`
  (14 px), a control, a banner and a well `rounded-lg` (10 px), a chip, a
  pill, a badge, a segment and a menu item `rounded-md` (8 px), a counter, a
  `kbd`, inline code and a 24 px tile `rounded-sm` (6 px), a dot
  `rounded-full`. A menu is padded by 6 px, so its items' 8 px meet its
  14 px; a segmented control by 2 px, so its segments' 8 px meet its 10 px.
  **A control keeps its component's radius**, with no override; a hand-drawn
  control takes a field's.
- Surfaces, the landing page's tiers, never a hard offset shadow:
  - a **panel**: `card`, a `border` hairline, `shadow-panel`, the soft
    layered shadow of the landing page's cards with the highlight along its
    top edge;
  - a **raised** object, `popover` with `shadow-raised`: a chosen segment,
    the site switcher's card in the sidebar;
  - a **float**, `popover` ringed by the hairline with `shadow-float`: a
    menu, a select's list, a dialog, a tooltip;
  - a **well**, `sunk` with `shadow-well`, an inset shadow: a field, a
    select, a command, a code block, a gauge's track, a segmented control's
    frame;
  - a **chip**, `cell` with the hairline and no shadow: a counter, a tag, an
    access, a role, inline code;
  - a **tile**, `Tile` in `page.tsx`: 40, 32 or 24 px, `tile` ringed by the
    hairline, a highlight along its top, neutral or in a feature's tint; it
    always labels something, an empty state's title above all.
- The primary button is pressable: the gradient from `primary-hi` to
  `primary-lo`, its `primary-edge`, `shadow-btn` (a highlight along its top,
  a shade along its bottom, soft drops), its label pressed in with a shade;
  a hover brightens it by 6 %, a press sinks it a pixel into
  `shadow-btn-press`. The secondary, `outline`, is raised: `popover` fading
  into `card`, the `input` edge, `shadow-btn-2`, a press into
  `shadow-btn-2-press`.

## 3. Layout

### 3.1 The shell

```
Computer (>= 768 px), machine level
+--------------+-----------------------------------------------------------+
| sitesolide   | Sites 13                * 3 errors, 3 warnings  26s  [R]  |  sticky header
| example.com  +-----------------------------------------------------------+
| Sites      6 | [Banner: Can't reach the dashboard / collector stale]     |
| Activity     |                                                           |
| People       |                                                           |
| Tokens       |   plate, Issues, search and filters, list of sites        |
| Connectors   |                                                           |
| Dark mode    |                                                           |
| Sign out     |                                                           |
| Collapse  ^B |                                                           |
+--------------+-----------------------------------------------------------+

Phone (< 768 px), inside a site
+------------------------------------+
| logo All sites > cms       [R] [.] |
|      Secrets (switch site)         |
| * 3 errors  26s     [page actions] |
+------------------------------------+
|  content, px-4                     |
+------------------------------------+
| Overview  Audience  ...  Backups   |  mobile tabs, fixed, h-16, one row
+------------------------------------+
```

The sidebar is the shadcn `sidebar` component (`collapsible="icon"`), 232 px
wide (`SIDEBAR_WIDTH` in `lib/sidebar.ts`, repeated as `--pending-sidebar-width`
for the column held before React mounts). Its header: the logo, the wordmark
and, below it, the zone the server serves, once the first snapshot has said it.
An entry is 36 px tall, its stroke icon 16 px, in `secondary-foreground`.
Collapsed with `Cmd+B`, `Ctrl+B` or its button: icons only, 48 px, a tooltip, a
tone dot on the icon when the indicator is `attention` or `error`. The state
lives in `localStorage["sidebar-collapsed"]`, read back before the first render
by an inline script. The sidebar lies on the paper, ruled from the page by a
hairline. The current page takes the `highlight` tint ringed by
`highlight-line`, `strong` text and its icon in the accent, where a hover only
takes the `muted` grey; on a phone, a 2 px teal rule above the tab. A count
beside an entry sits on its tone's solid badge. The sidebar's own controls
(theme, sign out, collapse) sit at its foot in `muted-foreground`, the release
below them in mono.

**Two levels.** On the machine's pages (Sites, Activity, People, Tokens,
Connectors), the sidebar carries them. Inside a site it becomes that site's: the *All sites*
return, the current site on a raised card (its initial on a tile, name, state
in one sentence, tone dot), which opens the site switcher, then its five sections,
Overview, Audience, Secrets, Access and Backups. Collapsed, the site is just
its initial and its dot. On a phone the tabs follow the level: five for the
machine, five for a site, on one row.

**A person's shell.** Someone signed in with their company account sees the
pages that are theirs and no other entry (`machinePagesFor` and `sectionsFor`
in `lib/pages.ts`, following the steward's own table of powers). At the
machine level, Sites and Activity, and Tokens when a role or the create right
lets them mint a token. In a site, by their role there:

| Role | Sections |
|---|---|
| Viewer | Overview, Audience, Access read only: its general access and its people with access |
| Developer | Overview, Audience, Secrets, Access |
| Admin | all five |

Their email sits above the sidebar's own controls, in `muted-foreground`. A
page of the owner's, reached by its address, says *Only the owner's* in an
empty state rather than an error, and a section their role does not open,
*Not part of your role*: the service refuses both too.

Indicators (`lib/sidebar.ts`). Machine: *Sites* the number of discrepancies (error
if there is one, otherwise attention); Activity, People, Tokens and
Connectors report nothing. Site: *Overview* its discrepancies; *Secrets* what
its store and its files ask for, a declared name or file not set and a missing
file as an error, unmanaged, a unit that does not read its store yet or a
restart pending as attention; *Access* its general access disagreeing with `sitesolide.json`
(error), and nothing else: who has access is a choice, not a problem.
*Audience* and *Backups* report nothing. Zero is not shown.

### 3.2 The screen decides the shell, the container decides the content

**One rule, no exception**: everything laid out inside the content, columns,
table or list, follows its container's width through an `@container` query,
never the screen's. The expanded sidebar takes 232 px: at 1024 px the content
has only 728, and an `lg:` rule would put two 352 px columns there. The screen
(`md`, 768 px) decides only the shell: sidebar or tabs, header arrangement,
gutters, bottom margin, touch target size.

| Container | Threshold | What changes |
|---|---|---|
| `@container/table`, every `DataTable` | `narrowBelow`, 42 rem unless the page says 36, 48 or 56 | one line per row in columns under a sticky head, otherwise two lines and no head |
| `@container/filters`, every `FilterBar` | `@xl/filters:` (36 rem) | the search, a button per facet, the count and the sort; otherwise the search and one *Filter* button that opens a bottom sheet |
| `@container/body` | `@4xl/body:` (56 rem) | two columns: a site's Overview and Audience |
| list of sites on the home page | `@4xl:` | table, otherwise list |
| a site's Activity panel (Secrets, Backups) | `@2xl:` (42 rem) | table, otherwise list |
| the machine's Activity log, five columns | `@3xl:` (48 rem) | table, otherwise list |
| Activity filters | `@4xl/body:` (56 rem) | five fields on one row, otherwise two columns |
| machine plate | `@2xl:` | four columns, otherwise four rows |
| Issues panel | `@lg:` (32 rem) | messages aligned behind the slugs |
| `@container/file` | `@xl/file:` (36 rem) | Name, Value and action columns |

Useful content widths: 1088 px at 1440 with the sidebar expanded, 984 at 1280,
912 at 1024 collapsed, 728 at 1024 expanded, 358 on a phone.

### 3.3 The page header

`PageHeader` is the first element of every page:

```
[breadcrumb]
Title [count] (i)        [primary action] [History] [Unlocked, 9 min x]  * All clear  26s  [R]
```

- **Left**: the breadcrumb inside a site (*All sites > cms*), the focusable
  `h1`, its `count`, the number of what the page lists and the same the
  sidebar and the rows count, and the (i) that opens the page's `intro` in a
  popover: what the page is for and what it never shows, the paragraph a
  page used to open with. No intro paragraph in a page's body.
- **Right**: the page's controls, `actions`, one primary among them at most,
  default size (`max-md:h-10`); then *History* (`history`, a filter of
  lib/history.ts), a ghost button with its clock that opens Activity
  narrowed to this page's object, its icon alone on a phone; then, while
  changes are unlocked, the attention pill *Unlocked, 9 min* whose x locks
  again (`UnlockedPill`, drawn by the header itself on every page); then the
  machine's verdict, the age of the data, the refresh control.
- **Look.** A sticky band in the page's colour, ruled below, at least 68 px
  tall on a computer like the sidebar's header; its height is `--page-header`
  on the root, under which a table's head sticks. The verdict stays on the
  right on every page: there it reads as the machine's, where beside a
  site's title it would read as that site's state.
- **Phone.** The title row keeps the logo, the title, the count and the (i),
  with refresh and the menu; the verdict, the age and the pill move under
  it, the actions and History sharing their row when they fit.
- **Title.** The home page is called *Sites*. Inside a site, Overview carries
  the slug, the other sections their name.
- **Banners** follow the header: data unreachable or stale, a person's unlock
  that came back refused, a lock refused, and, after a person's re-sign-in,
  "Unlocked. Press New token to finish.".
- Panel actions: `size="sm"`.
- An action does not appear until what it presupposes has been read: *Add
  people* and the role menus wait for the list of people with access, *Make
  public* and *Restrict* for the steward's word on whether the site may
  change.

## 4. The primitives

A page does not write its own version of any of them.

### 4.1 Data and navigation

| Name | File | Use |
|---|---|---|
| `useData()` | `data.tsx` | everything the pages read: snapshot, verdict, age, secrets, who is signed in (`identity`), `sessionExpired`, `refresh` |
| `useNavigation()` | `navigation.tsx` | `{ page, path, params, fromHistory, navigate(href, { replace? }) }` |
| `useListState(spec)` | `filter-bar.tsx` | a list's search, facets and sort, read from the address and written back to it (`?q=`, a parameter per facet, `?sort=`), replacing the entry; the pure half in `lib/list-state.ts`, `narrowList` for the rows and the facets' counts |
| `useSheet(param)` | `detail-sheet.tsx` | `{ id, open(id), close() }`: a sheet addressed by `?token=`, `?person=`, `?event=`, `?connector=`; open adds a history entry, so Back closes it |
| `historyUrl(filter)`, `readHistory(params)` | `lib/history.ts` | Activity's address, the one every History link speaks: `actor`, `action`, `target`, `source`, `type`, `since` |
| `InternalLink` | `navigation.tsx` | every link to another dashboard page, a real `<a href>` |
| `readAddress`, `requestedSite` | `lib/pages.ts` | the page and parameters of an address |
| `pageUrl`, `siteUrl(slug, section)` | `lib/pages.ts` | addresses, always with the trailing slash |
| `useSite(slug)` | `site.tsx` | what a section reads of its site |
| `useSecretsActions()` | `secrets-actions.tsx` | every action that goes through the steward, and their dialogs |
| `useAnnounce()` | `copy.tsx` | the shared `aria-live` region |

Reads live in `DataProvider`, above the pages: one on opening, then every
30 s while the tab is visible, and on every `focus`, `visibilitychange` and
`online`; one call in flight at a time; a failure keeps the data and raises a
banner. Writes stay in the components that make them, which call `reload()`
afterwards. A page never reads `window.location` itself.

### 4.2 Surfaces and states

| Name | When |
|---|---|
| `PageBody` | the content container, and the `body` query container |
| `SitePage` | a site's section: header with breadcrumb and switcher, body, "No site named x" for an unknown slug, "No project named x that you have a role on" for a person, with whom to ask |
| `Panel` | a panel, `rounded-xl`, its hairline and `shadow-panel`, clipped rather than scrolled so that a head can stick; with `title`, a 44 px header row; `full` for a table or list that touches the edges |
| `DataTable` | `data-table.tsx`: the one list pattern (5, *Lists*), inside a `Panel full` |
| `FilterBar` | `filter-bar.tsx`: the one filter row (5, *Search and filters*) |
| `DetailSheet`, `SheetFacts`, `SheetSection`, `SheetRecent` | `detail-sheet.tsx`: the one detail pattern (5, *Details*) |
| `InlineEmpty` | a panel or a section with nothing in it: one 44 px line, a 16 px icon, the state, one action |
| `WithSnapshot` | loading, dashboard unreachable, snapshot incomplete, rendered the same everywhere |
| `EmptyState` | nothing to show: its icon on a tile, the title states the state, the text says what to do |
| `Tile` | an icon on its tile, 40, 32 or 24 px, neutral or in a feature's tint and ink; it labels the title beside or under it |
| `ErrorState` | a page-specific read failed and there is nothing else: a title naming what did not answer, advice and a command, *Retry* |
| `Banner` | a problem that does not stop you reading: kept data, a site's discrepancy, a refused removal |
| `RowsSkeleton`, `PanelSkeleton` | a load, shaped like what it replaces, `aria-busy` on its container |

The header always shows, only the content becomes a skeleton; no "Loading" text
on screen.

### 4.3 Statuses and small elements

| Name | Rule |
|---|---|
| `Status` | a dot with its halo and a word. `point` in lists and tables, `pill` for what has to be seen from afar |
| `SeverityIcon` | crossed circle (error) or triangle (warning) before a discrepancy, with hidden text |
| `SeverityGutter` | a row's 28 px gutter: the `SeverityIcon` when it is in trouble, nothing when it is fine |
| `StateLabel` | a row's state, quiet when fine: nothing for `ok`, a muted word for `neutral`, the word in its tone, 13 px, otherwise; `more` adds "+2" with every message in its tooltip |
| `KindIcon`, `AccessIcon`, `LegendEntry` | `legend.tsx`: the icon vocabulary (5, *Icons*), each with its tooltip in the Access section's words |
| `RowMenu`, `RowMenuLink` | the row's "..." and its items, navigation first, copies, writes, destructive last under a separator |
| `RowLink`, `RowButton`, `CellText` | a row's name as the real link to its page or the button that opens its sheet; a cell's text cut with an ellipsis, whole in its tooltip |
| `WriteButton`, `WriteMenuItem`, `useWrite`, `LockGlyph` | `unlock.tsx`: a write that asks for the unlock when pressed while locked, carrying the glyph until then |
| `UnlockedPill` | the header's *Unlocked, 9 min* and its x, drawn by `PageHeader` |
| `HistoryLink` | the header's *History*, Activity narrowed |
| `Count` | the number beside a title, the landing page's mono chip: `cell`, the hairline, Plex Mono |
| `CHIP`, `AccessWord` | a 20 or 24 px chip; a site's general access as the landing page's badges, *Restricted* with a lock, *Public* with a globe and quieter, *Anyone with the code* with a key over the code in its well |
| `RoleBars` | a role as four rising bars, as many lit in `share-ink` as the role has rungs, before its word: beside a site's name, in a role's menu, in what each role can do |
| `ExternalLink` | a site address, underlined at rest, in a new tab; the address in mono |
| `MachinePlate`, `Track` | the plate, reserved for the home page: one panel, the server (its zone, cores, memory and disk) then load, memory and disk, each under its mono label; `Track` is a 6 px groove with a 1 px tick across it at each threshold, reused for a service's memory |
| `Track` (dialogs) | waiting for a long answer: the time actually elapsed on its scale, the usual duration ticked when known, never an invented progress bar |
| `Command` | a command to type in a terminal, copyable |
| `serviceWord` | the word and tone of a systemd unit, the same on the home page, the Overview and Secrets; *Scheduled* for the anchor of a project whose every service is scheduled, `active (exited)` |
| `scheduledWord`, `runLines` | a scheduled service's word, *Waiting* between two runs and never *Down*, and its last and next runs under it |

shadcn components available in `src/components/ui/`: `alert-dialog`, `badge`,
`button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`,
`progress`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `table`,
`tooltip`. The sheet's scrim is light and unblurred, a list being read
beside its sheet.
Add with `bunx --bun shadcn@latest add <name>`. The Ledger look lives in their
own class strings, which were edited for it (the pressable and raised
buttons, the sunk fields and selects, the floating menus and dialogs, the
mono column heads, the chips): a component added again over one of these
overwrites that look, so the new file is compared with the one it replaces
before it is kept. Beyond the look, a component is varied through `data-slot`
or wrapped.

## 5. Content rules

**Lists.** One pattern, `DataTable`, in a `Panel full`, for every list of
the dashboard:

```
| 28 gutter | NAME minmax(..)    | COLUMN | COLUMN | AGE 96 | 44 menu |    one line, 44 px (40 dense)
[x] [icon] roster  Restarting +2   roster.example.com   [icon]   24m ago   ...
```

- **Head**: 40 px, `bg-cell`, the mono capitals of `mono-label`, ruled in
  `border`, sticky under the page header. **Rows**: 44 px, ruled in
  `divider`; `dense` makes 40 for Activity and Backups. The row's padding is
  16 px, a cell's 12, the first column's none.
- **Columns**: the name first, then at most four short ones. Machine
  strings in muted mono, 13 px; numbers and ages right-aligned and
  tabular; an icon column centred, 64 to 76 px. A cell that may not fit
  cuts with an ellipsis and keeps its whole text in its tooltip (`CellText`).
- **Two lines** below the width the columns need (`narrowBelow`, the
  table's own width): 56 to 60 px, each column where its `slot` says,
  `primary` top left, `state` top right, `meta` bottom left in 12 px muted,
  `time` bottom right, `hide` nowhere; the menu at the right across both
  lines. The head goes: the rows say what they are.
- **Gutter**: given `severity`, a 28 px first column holds the
  `SeverityIcon` of a row in trouble and nothing for a fine one, the line
  the eye scans for problems; the row's word, a `StateLabel`, follows the
  name. No tinted background, no word for a fine row.
- **Click**: a row is a page (`rowHref`) or a sheet (`onRowClick`). Its name
  is the real link (`RowLink`) or the sheet's button (`RowButton`), the one
  for the keyboard and for screen readers; the rest of the row follows the
  click in code, so an address stays selectable. Cmd, Ctrl and the middle
  button open a page in a new tab. The row whose sheet is open takes the
  `highlight` tint.
- **One action in the row at most**, the page's job, as a small outline or
  ghost button in its own column or on hover; everything else in the
  `RowMenu`.
- `label` names the table for screen readers, `caption` says the order and
  the filter. Under the rows, `foot` for one quiet line: *Show 1 revoked or
  expired*, *Show all 37*, *Load older*. Many rows: the same 44 px, the
  sticky head and the filters, no pagination.

**The row menu.** `RowMenu`, a 32 px ghost "..." at the row's end (40 on a
phone): where to go first (`RowMenuLink`, *Open site*, *Access*), then what
to copy, then the writes (`WriteMenuItem`), and last, under a separator, the
destructive one in `variant="destructive"`, still confirmed in its dialog.
Each item names its object: *Revoke token*, *Remove from every project*. A
destructive action is never a bare cross in the row.

**Details.** A list whose rows are not pages opens each row in the
`DetailSheet`: from the right at 440 px on a computer, from the bottom at
up to 90 % of the height on a phone. Its head: the object's name, its
`StateLabel`, its actions as buttons, destructive last. Its body: every
field as a key and its value (`SheetFacts`, 36 px lines), the sections the
object needs (`SheetSection`, a mono label over its content), then
*Recent*, the object's last ten lines of Activity, and *All activity*
(`history`). Its address is the page's (`useSheet`): `?token=`, `?person=`,
`?event=`, `?connector=`; Back closes it, a link opens it.

**History.** A page's own activity is in Activity, never in a panel of the
page: the header's *History* opens it narrowed (`historyUrl`), a sheet's
*Recent* shows its object's last ten lines. The address's six parameters
are the contract: `actor` (part of it, `token:`, an email, `owner`),
`action` (the start of a dotted action, `access`), `target` (a slug or a
host), `source` (`dashboard`, `portal`, `egress`, `backups`, `steward`),
`type` (`deployments`, `access`, `secrets`, `signins`, `tokens`, `backups`,
`egress`, `HISTORY_TYPES`), `since` (`24h`, `7d`, `30d` or a day,
`2026-10-21`).

**Empty is small.** Inside a panel, `InlineEmpty`: one 44 px line, a 16 px
icon, the state, one action ("No token yet." *New token*). A section with
nothing in it and nothing to ask disappears: an issues list at zero, revoked
tokens, requests, files. The tiled `EmptyState` stays for a page with
nothing at all: a first run, *Only the owner's*, *Not part of your role*,
a search that finds nothing. An empty list is never a bordered box with "0".

**Icons.** lucide's, 16 px in a row, muted unless they carry a state, each
with one meaning everywhere and its words in its tooltip (`lib/legend.ts`):

| Icon | Means | Colour |
|---|---|---|
| `Files` | Static site: serves its files, no service runs | muted |
| `AppWindow` | App: serves pages through a service | muted |
| `Cog` | Background: serves no page, runs for good | muted |
| `CalendarClock` | Scheduled: every service runs on a schedule, serves no page | muted |
| `FileQuestion` | No manifest | muted |
| `Globe` | Public, the quiet default | muted |
| `Lock` | Restricted to the people with access, once signed in; the tooltip names the exempt paths, "Open to anyone, guarded by the app alone" | foreground |
| `KeyRound` | Anyone with the code; the tooltip shows the code to whoever may read it | foreground |
| `ShieldAlert` | `sitesolide.json` and the server disagree on how it opens | destructive |
| `CircleX`, `TriangleAlert` | an error, a warning, in the gutter | their tone |
| `History` | Activity, narrowed | muted |
| `User`, `RectangleEllipsis`, `Building2` | People's rows: someone with a company account, someone with password access, everyone at a domain | muted |
| `Pause`, 12 px | a project or a permission a person's token holds but may not use now, their role being below it | muted |
| `Lock`, 12 px, after a label | a write that asks for the unlock first | the label's |

The facet menus show the same icons beside the same words: they are the
legend. A sheet's facts use `LegendEntry`, the icon and its word.

**Writes and the unlock.** The unlock is asked for just in time, as a sudo
mode: no page carries an *Unlock changes* button nor an *Unlock to ...*
one. A write says what it does, *New token*, *Add*, *Make public*,
*Restore*, and while changes are locked carries `LockGlyph`, 12 px after its
label; pressed, it opens the unlock, titled after what waits ("Unlock to
create a token", the write's `purpose`), then performs (`WriteButton`,
`WriteMenuItem`, `useWrite().run` for a form or a checkbox). A write the
steward takes without the unlock, *Restrict*, *Revoke*, a person's
*Restart*, has `unlock={false}` and no glyph. The confirmations stay where
they were, after the unlock. A person unlocks by signing in again at their
provider: they leave the page and come back to it, what they typed kept by
`beforeLeave`, and the header says what to press again, "Unlocked. Press
New token to finish." (`resume`). A 423 met on the way locks and asks
again, without replaying the write. While unlocked, the header's pill says
*Unlocked, 9 min*; its x locks at once.

**Buttons.** One primary per view, the pressable teal; the others raised
(`outline`) or quiet (`ghost`). `destructive` is used only for a
confirmation's action. A button in progress says what it is doing:
*Revoking...*, *Saving...*.

**Dialogs.** `Dialog` to type into (anchored at the bottom on a phone), or for
an action that waits a long time for its answer; `AlertDialog` to confirm. A
wait in progress neither closes nor cancels: the server sees it through. A title
naming the object, a description stating the consequence, the primary action on
the right. Focus goes to the first field, then back to the originating element.

**Errors.** Say what did not answer and what to do, without apologising: "Can't
reach the access service on the server. Retry in a moment; if it persists, run
sitesolide status." Under the offending field (`role="alert"`), in a `Banner`
when the page stays readable, in an `ErrorState` when there is nothing to show.

**Search and filters.** One `FilterBar`, under the header:

```
[Search sites   /] [Access v] [Kind: Apps v|x] [Clear filters]          3 of 14  [Issues first v]
```

- The search on the left, 240 px, its `/` hint for the mouse and the
  keyboard; `/` focuses it from anywhere but a field, Escape clears it, then
  gives focus back.
- A button per facet, single choice, a menu of its values, each with the
  rows' own icon, its word and its live count, taken under the search and
  the other facets (`narrowList`); the menu is the legend. Once chosen, the
  button reads "Access: Restricted" and an x clears it; *Clear filters*
  appears from two filters.
- On the right "3 of 14" only while narrowed, the header counting the
  whole list; then the sort, its order's name, a menu of the orders.
- Below 36 rem of its own width: the search and one *Filter* button with
  the count of facets chosen, which opens a bottom sheet holding the facets
  and the sort as 44 px choices, applied as chosen, with *Clear filters*
  and "Show 3 sites".
- Its state is the address's (`useListState`): `?q=`, one parameter per
  facet, `?sort=` when not the default, written by replacing the entry, so
  that a reload, a link and Back give the same list and a keystroke is not
  a history entry.
- Shown from ten items (`FILTER_BAR_FROM`); always on Sites and Activity.

**The platform's own projects**, the dashboard, the portal and analytics,
known by their slug on their own port (`Site.platform`), have their chip,
*Platform*, last and only while the list carries one; a Platform chosen
then gone falls back to All. Every other filter lists them only while they
need the owner, an issue of either severity or a restart pending: a healthy
portal is nothing to look after, a broken one goes to the top of All and
under Issues, and each filter keeps a part of what All lists. Under Platform
the count is of its own set, "3 platform projects". On a phone five chips
share one row, six take two rows of three.

**Secrets and passwords.** A field that receives a secret is `type="password"`,
`autoComplete="off"`, `data-1p-ignore`; a textarea, which cannot be, is masked
with `[-webkit-text-security:disc]` plus *Show*. A revealed value lasts thirty
seconds and is masked again on locking, tab hidden, page left, site or section
changed. A password variable offers only *Change password*. A drawn password is shown once,
with its copy button; closing its dialog without having copied it takes two
gestures, the first one warning.

**Keyboard and announcements.** Every focus ring is teal. A hand-drawn
element takes `focus-visible:ring-2 focus-visible:ring-ring`, solid, 5.8:1 on
`card` in light; a button, the landing page's 2 px teal outline, 2 px off
its edge; a field, generated or hand-drawn, `focus-visible:border-ring`
(solid, the same contrast) inside a `ring-3 ring-ring/25` halo, the halo alone
being too pale to count, its well lightening to `popover` in light while it
has the focus.
After a navigation: scroll to top (except on back), focus on the `h1`, title
announced, tab title updated. One `aria-live` region, through which a password
or a value never passes. Under the sign-in of an expired session, the page is
`inert`.

## 6. Vocabulary

| Object | Word | Do not write |
|---|---|---|
| Machine pages | Sites (the home page), Activity, People, Tokens, Connectors | Dashboard, Home, Overview, Members, Team |
| Connectors | Connector, Add connector, Change, Remove connector, Requests, Grant, Withdraw, Granted, Granted, asked for, Asked, not granted, No such connector, Not asked for, Site removed, Base address, Header, Changed, Write-only (in the dialog and the sheet, never in a row) | Integration, Secret, Token, Revoke access, Grants |
| Site sections | Overview, Audience, Secrets, Access, Backups; the breadcrumb *All sites > cms*; *Switch site* | Settings, Details, Sharing, Guests, Members |
| The machine | Server | VM, host |
| Discrepancy | Refusal, issues; Error, Warning | Alert, Critical |
| Verdict | All clear, `N errors, N warnings`, Stale data, No data | OK, Healthy |
| Age | Updated 26s ago, just now | Last sync |
| Service | Running, Starting, Restarting, Stopping, Down; Static files, No manifest; Unknown; Scheduled, for a project whose every service is | Up, Offline, Dead |
| Workers and scheduled services | Background; Runs hourly, or the schedule as written; Waiting, Running, Last run failed, Schedule stopped, No timer, Not loaded; Last run 3h ago, Failed 3h ago: exit code 1, Started 2m ago, Last started 5h ago, No run yet, Next run in 42m; Main unit; Runs in the background, serves no page | Idle, Cron, Job, Daemon, Down for a scheduled service between its runs |
| General access | General access, Public, Restricted, Anyone with the code, Current; Make public, Restrict; in a disagreement, On the server, In sitesolide.json, Keep Public, Apply Restricted; Preview code, Replace the code, Remove the code; Open to anyone, guarded by the app alone (the exempt paths); See changes in Activity | Door, Gate, Portal on, Portal off, Turn on portal, Behind the portal, Private, Password protected, Enable, Disable |
| People with access | People with access, Add people, Add, Remove; Can open, Viewer, Developer, Admin; company account, password access, Password access lasts, No expiry, expires in 5d, Expired, Added by; Can't sign in until company sign-in is set up; Copy message; What each role can do, a disclosure from Can open to Admin, (your role), (you); Also open it | Sharing, Share, Guest, Member, Team, Invite, Permissions, ACL, work account, Super admin, Project admin; an Owner row or rung |
| People | People, Person, Projects, Expires, Type; Company account, Password access, Domain, as facets Company accounts, Password access, Domains; Creates projects (a row's tag), May create projects, Let someone create projects, Let create projects, Stop creating projects, Allow, Company email, Remove from every project, Remove expired, 1 password access has ended.; No project yet, Every site, as admin: set on the server in OIDC_ADMIN_EMAILS | Members, Invite |
| Tokens | Tokens, New token, Create token, Name, Owner, Projects, Permissions, Last used, Expires; You, Never, No expiry, in 4d, Expired, Revoked, Paused; the chips Public sites, Secrets, Domain, Network, New projects, and their sentences Can deploy public sites, Can manage secrets, Can declare a domain, Can use outbound network, Can create projects; Paused: no longer allowed, Paused: Viewer now; Made by, Created by it; Whose token, Mine, For someone in People, Projects it may deploy, All projects (13), Filter projects, Permissions: None, Needed by cms, Deploys cms and photos, expires in 90 days, no extra permission.; Show 1 revoked or expired, View activity, Revoke token, Revoke "alice-ci"?, Copy message | Team, API key, Yours, Their own, Active, Public sites allowed, Restricted sites only, Write secrets, Secrets access, Recent deployments, Token activity |
| The lock | Unlocked, 9 min, and its x, Lock changes now; in its dialog, Unlock changes, Unlock to create a token (the write that waits), Unlock, Sign in again; under a field, Giving Developer asks to unlock changes first.; after a person's re-sign-in, Unlocked. Press Add to finish.; in Activity, Unlocked changes, Locked changes | Unlock the secrets, Locked, Unlock to add, Unlock to create, Unlock to allow, an Unlock changes button |
| Kind | Static site, App, Background, Scheduled, No manifest; as facets, Static, Apps, Background, Scheduled; Runs in the background, serves no page | Worker, Service, Job, Cron, Daemon |
| Lists | Search sites, Filter, Clear filters, Sort, Issues first, Name, Last deployed, 3 of 14, All, Show all, Show 1 revoked or expired; an access facet's Public, Restricted, Anyone with the code, Mismatch; Access mismatch beside a name | Reset, Filter by, Results, No results |
| Secrets | Restart pending, Unmanaged, Missing, Restart service, Restore previous, Add variable, Create file, Reveal; a store's: Variables, Files, Server, Not set, Declared, Not declared, Empty, Set, Generate, Type a value, Generate on the server, Upload, Upload file, Replace, Remove, Restore previous version, Build, kept by whoever deploys, Public, from the repository | Vault, Decrypt, Edit file, Rotate, Secret store, Environment |
| Passwords | Change password, Dashboard password, Generate a strong one, Set my own, New password, Copy password | Set hash, Regenerate |
| Backups | Snapshot, Scheduled, Before restore, Server, Offsite only, Restore, Restoring..., Restored, Offsite copy, Show all | Backup file, Revert, Rollback, Recover |
| Activity | Event, Actor, Action, Target, Source, Site or host, From, To, Details, Load older, Export, CSV, JSON lines, Clear filters, Access changes; a source is Read, Latest 50, Can't read, Needs updating, Not installed; an actor is Owner, The server, Someone, alice@example.com (token), Example Accounting (password access) | Log entry, Audit trail, Download, Reset |
| Unreachable | Can't reach the dashboard., Can't reach the server's secrets., Can't reach the access service on the server. | is not answering |
| Common actions | Refresh, Retry, Sign in, Sign out, Copy, Copied, Cancel, Close, Done, Manage, See, History, All activity, Recent | Reload, Try again, Log out, Submit, Audit, Logs |
| Empty states | No issues, No sites match "x", No site is restricted, No sites deployed yet, No project of yours yet, No project named x that you have a role on, Nobody else has access to cms yet, Nobody has access to a project yet, cms has no secret files, Not part of your role, Only the owner's | Nothing here! |

"Portal" names the component, on the machine: Activity's source for sign-ins,
the banner saying the portal on the server still reads its own lists, the
portal's own `portal.env`. Never the way a site opens: that is its general
access.

Active voice, sentence case, no exclamation marks.

## 7. The pages

One page per served file, the site in `?s=`:

| Page | Address | File |
|---|---|---|
| Sites, the home page | `/` | `index.html` |
| Activity | `/activity/` | `activity/index.html` |
| People | `/people/` | `people/index.html` |
| Tokens | `/tokens/` | `tokens/index.html` |
| Connectors | `/connectors/` | `connectors/index.html` |
| A site's Overview | `/site/?s=cms` | `site/index.html` |
| A site's Audience | `/site/audience/?s=cms` | `site/audience/index.html` |
| A site's Secrets | `/site/secrets/?s=cms` | `site/secrets/index.html` |
| A site's Access | `/site/access/?s=cms` | `site/access/index.html` |
| A site's Backups | `/site/backups/?s=cms` | `site/backups/index.html` |

Older addresses keep their file and redirect client-side, with no history
entry (`LEGACY_PATHS` in `lib/pages.ts`): `/sites/?site=cms` and
`/secrets/?site=cms` from before the per-site page, `/guests/` to the home
page, `/team/` to Tokens, `/members/` to People, and a site's
`/site/guests/`, `/site/sharing/` and `/site/members/` to its Access, `?s=`
kept. A section without `?s=` goes to the home page.

**Sites (the home page).** The machine plate (the server, its zone and its
size, then load, memory and disk, with their ticks at 70 and 90 %), the Issues
panel, errors first (a disagreement on general access names each side,
"Restricted in sitesolide.json, public on the server: anyone can open the
site. Choose one in its Access section"), then the search, the filters (All,
Issues, Apps, Static, Restricted, Platform, each with its count) and the
inventory, sites in discrepancy at the top: Site, Address, Access, Service,
Size. A platform project carries a quiet *Platform* tag beside its name, the
word the search finds it by. A search under All that finds only platform
projects says so, "The platform's own projects are under Platform, where 2
match.", with *Search platform projects*, the query kept. A server with no
site of the owner's yet reads "No sites deployed yet", "A site appears here
after its first sitesolide deploy, run in the project's folder. The
platform's own projects are under Platform.", with *Show platform projects*;
the search and the chips stay. A project that serves no page says so under its address, "Runs in the
background, serves no page"; its Service column sums what its running
services weigh, a scheduled service between two runs weighing nothing, and
a project whose every service is scheduled reads *Scheduled* with its next
run, "next run in 5h". The Access column gives the general access in the Access section's
words, *Restricted* with the paths "Open to anyone, guarded by the app
alone", *Public*, or *Anyone with the code* over the code itself with its
copy and open buttons; a disagreement with `sitesolide.json` in red, in the
same words ("Restricted in sitesolide.json, public on the server"). A person
sees their role as a tag beside each site's name, *Your role* as its title;
with no project yet, "No project of yours yet", and with the create right
"You may create projects: create a token on the Tokens page, then run
sitesolide deploy in the project's folder. You become its Admin.", never the
server's folders. Summaries live in the rows, not in cards.

**Activity.** The machine's audit, every component's in one log, newest first,
read with the session alone since no row holds a value. *Export* in the header,
CSV or JSON lines of the rows read, once something has been read. Then the
sources once, each with its state in a word (*Read*, *Latest 50*, *Can't
read*, *Needs updating*, *Not installed*), and a banner for each source that
could not be read, saying what to do. Then the filters: the source as chips
like the home page's, and *Access changes*, the actions that start with
`access`; then *Actor*, *Action*, *Site or host*, *From* and *To*; typed
fields apply once typing pauses, the count on the right. The address may carry
`actor`, `action`, `target` and `source`, which is how a site's Access opens
the log narrowed to its changes. The log: Actor, by name (*Owner*, *The
server*, *Someone*, `alice@example.com (token)`, `Example Accounting (password
access)`, *Someone with password access* on older rows); Action, a sentence
("Gave dana@example.com Developer on cms", "Changed dana@example.com from
Developer to Can open on cms", "Restricted cms", "Signed in with the owner's
password", "Opened calendar as Admin"), its tone when it went wrong, the
dotted action and a note below; Target (the site linked, the host below),
Source, When, and *Details*, which opens every field and the detail as key
and value, text only. *Load older* at the foot while a source has more; a page
that finds nothing goes on by itself a few times before handing the choice
back. Under the panel, which sources only hand over their latest entries.

**People.** The owner's alone. Its intro, behind the title's (i): roles are
given and changed in each project's Access section, here someone is let
create projects or removed from every project at once. In the header, while
company sign-in is set up, *Let someone create projects*: it asks for the
unlock, then a small dialog takes a company email and *Allow*; *History*
opens Activity on access changes. A banner when company sign-in is not set
up, since everyone added then gets password access.

Then one list, the header counting its rows: everyone with access to a
project, by email or name, then every domain; from ten rows a search and a
*Type* facet, *Company accounts*, *Password access*, *Domains*, with the
rows' icons. A row, 44 px: its kind as an icon, `User`, `RectangleEllipsis`
or `Building2`, and who, *Creates projects* as a quiet tag on whoever may;
its projects, each linked to its Access section with the role muted beside
it, "calendar Admin, cms Developer +1", a password access's project alone, a
domain's *Can open*, "Every site, as admin" for an admin email with no
project; *Expires* for password access alone, the soonest end still open,
"in 14h" in attention under a day, "in 6d", "No expiry", *Expired* muted.
The row menu: *Let create projects*, offered only to someone with a company
account, which asks for the unlock, or *Stop creating projects*, which does
not; then, under a separator, *Remove from every project*, in a destructive
confirmation: they lose every role and password access at their next
request, may no longer create projects, are signed out, and the tokens it
revokes are named, "Also revokes 2 tokens: Alice's laptop (made by you),
alice-ci (made by them)." A click opens the sheet (`?person=`): what they
are, the create right or why it is not offered, "Every site, as admin: set
on the server in OIDC_ADMIN_EMAILS.", every project with its role and a
password access's end, linked to its Access, the tokens they hold, their
last ten actions, and *Remove from every project* at its foot; a domain's
sheet, its projects alone. While a password access has ended, one line under
the rows says how many, with *Remove expired*, which lists them in a
confirmation and takes each off its project.

**Tokens.** One table, OpenRouter's keys: the tokens, and nothing of equal
weight beside them. Its intro, behind the title's (i), says what a token
does, the owner's or a person's; *New token*, the header's primary action,
asks for the unlock first; *History* opens what tokens did,
`/activity/?actor=token:`. The header counts the tokens that deploy; the
revoked and the expired fold under the rows, *Show 1 revoked or expired*.

A row, 44 px: *Name*; *Owner*, "You" or the person's email, for the owner
alone; *Projects*, "cms, photos" then "+2", a project where the person's
role is below Developer muted after the `Pause` glyph; *Permissions*, what
it may do beyond deploying, at most two chips then "+N", *Public sites*,
*Secrets*, *Domain*, *Network*, *New projects*, a person's paused one dashed
and muted with the glyph, why in its tooltip, "Can create projects (paused:
no longer allowed)", "Can use outbound network (paused: not Admin of cms
now)", "Can manage secrets (paused: no project to deploy now)", and nothing
for a token that only deploys; *Last used*, "5h ago" or "Never"; *Expires*,
"Jan 21", "in 4d" in attention within a week, "No expiry", *Expired*,
*Revoked*. No *Active*: the normal state says nothing; a token every project
of which is paused says *Paused* beside its name. Below 56 rem of the table,
two lines: the name and Expires, then the owner and the projects. The row
menu: *View activity*, then *Revoke token*, which needs no unlock.

A click opens the sheet (`?token=`): whose it is, who made it when that is
not its owner, created, last used and its expiry, each with its date; each
project with the role today, "Developer", "Paused: Viewer now", "Created by
it" for the owner's own; each permission with its sentence, a paused one
with why; its last ten actions in Activity's words, each over the site it
touched, and *All activity*; *Revoke token* at its foot. A person sees their
own tokens alone, with no Owner column, and mints them under their own
unlock, never beyond their roles; a person who is a Viewer everywhere reads
"Tokens are for Developers and Admins. You're a Viewer on every project."

The dialog fits a 900 px screen: its fields scroll between the title and
the buttons. A *Name*, and for the owner *Whose token* beside it: a menu
drawn by the page, not the browser's, with *Mine*, "Yours, for your own
agents", then *For someone in People*, each person by their email over a
line saying where they deploy and whether they may create projects, "Admin
on calendar, Developer on cms", "May create projects". A Viewer everywhere is
not offered, since the steward mints them no token, and with nobody to offer
the menu is left out. Then *Projects it may deploy*, a list to tick, never
slugs to type, six rows high before it scrolls, *All projects (13)* at its
head to tick them all and, from eight projects, *Filter projects*: the
owner's own offered every project on the server but the platform's, a
person's only those where they are a Developer or an Admin, each with that
role; and below them *New projects*, the create right, for a person only
while they hold it. Then *Permissions*, a disclosure closed while all are
off, its summary saying what is on, "Permissions None"; inside, one line each
on when it is needed: *Deploy public sites*, *Use outbound network*,
*Declare a domain*, the three of a person's only when they are an Admin of
every project chosen, the note saying so, "Public sites, outbound network
and a domain only when you are an Admin of every project chosen."; and
*Manage secrets*, "Lists each project's secret names, and sets, generates
and removes its variables and files on the server. Never reads a value
back.", never greyed for a person, a Developer changing a project's secrets
already, and sent only when ticked, so that a steward from before it still
mints the rest; ticked against one, the dialog says "The server's steward
predates this permission: run sitesolide upgrade." One a project chosen
cannot be deployed without is ticked for you and says which, "Needed by
bookshop and wheels": a public project for the owner's own, exempted paths,
a declared domain; the disclosure then opens by itself, the reason in its
summary. Then *Expires*, a segmented control. Above the buttons, one line
says what the token will be, "Deploys cms and photos, expires in 90 days, no
extra permission." The token is then shown once, with *Copy message*.
Revoking asks "Revoke "alice-ci"?", "Its next request is refused; a
deployment already running finishes.", and, for a token that created
projects, that they stay and only a new token granted them deploys them.

**The sign-in page** names the server under *Sign in*: the zone it serves,
in mono, `example.com`, from `/api/session`, so that whoever runs a test
install beside production sees which server the password goes to before
typing it; "Server dashboard" from a service that does not say it. An
expired session's overlay keeps the zone and says why below it. The card
is the portal's (`portal/src/page.ts`), which a visitor meets in front of a
restricted site, so that both read as one product: the landing page's 24 px panel, `rounded-3xl`, and its 44 px
controls with 12 px corners, the field the same well as every other, the
same pressable teal. It is the one place the dashboard takes the landing
page's sizes, being a page read once (section 8, point 15).

**The sign-in page, with a provider.** Above the password, *Sign in with
<provider>*, an outline link to `/api/sso/begin` and not a form, the flow
leaving for the portal's host; then a rule with *or with the owner's
password* in its middle. A sign-in that came back without a session says why
above both, in `destructive`: `can-open-only`, "This account can open some
sites, but the dashboard starts at Viewer. Ask an Admin of the project if you
need more."; `no-role`, "This account has no access to any project
here. Ask the owner, or an Admin of the project, to add you."; a domain not
allowed, expired, not available.

**Connectors.** Its intro behind the title's (i): what a connector is,
and that a project gets one when its sitesolide.json asks for it under
connectors and the owner grants it here, either alone lending nothing. *Add
connector*, the header's primary action, asks for the unlock first;
*History* opens Activity on the egress proxy's audit. First **Requests**,
only while something waits, its count its rows': a grant left to a site
that is gone, in error, with *Withdraw*; a project that asks for a connector
not granted, *Asked, not granted* in attention, with *Grant*; one that asks
for a connector the server lacks, *No such connector* in attention, with
*Add connector*, its name filled in. Then the connectors, one 44 px row
each: the name in mono, the base address without its scheme, muted and cut,
the projects it is granted to, "cms, roster", one that does not ask for it
muted, and when it changed; the row menu, *Change* and *Remove connector*,
each asking for the unlock first. A click opens the sheet (`?connector=`):
*Write-only*, said there and in the dialog rather than on every row; the
whole base address, the header, when it changed; every project it concerns,
its word and its one action, *Withdraw* or *Grant*; its last ten lines from
the egress proxy itself, its calls, changes, grants and the refusals to reach
it, and *All activity*; *Remove connector* at its foot. The add and change
dialog types the value in a password field and leaves it empty on a change
to keep it; a removal retypes the name.

**A site's Overview.** Under the title, the state in one sentence, the
description and the main address, "Runs in the background, serves no page"
beside it for a project that serves none; its discrepancies as banners. Then
two columns: on the left the site on the machine, **Service**, **Services**,
**Addresses**, **Storage**; on the right what opens it and what it keeps,
**General access** and **Secrets**, each with *Manage* to its section, General access's
after who has access in a few words, "6 people and 1 domain have access ·
Manage", *See* for whoever only reads who has access, a Viewer or a
Developer. **General access** names how the site opens and what that does to a
visitor, the code for *Anyone with the code*, the exempt paths for
*Restricted*, and, when it disagrees, `sitesolide.json` and the server side by
side. Every role sees it,
with its *Manage* or *See*; **Secrets** shows from Developer up. A Developer or an
Admin finds *Restart* in **Service**'s header, which confirms, waits for the
steward's verdict and says it in plain words, or shows the steward's refusal
as it stands.

**Service** is the project's main unit: *Main service* beside others, and a
worker's says *Port: None*, since it listens on nothing. For a project whose
every service is scheduled it is *Main unit*, the anchor, *Scheduled* while
active, with one sentence on what it does and no gauge. **Services** lists
every process of a project that runs several, or of one whose every service
is scheduled, the main one first: its name and unit, then what it receives,
its paths, *All other paths* or *Internal*, its port; *Background* for a
worker; for a scheduled service its schedule, *Runs hourly* or the
expression as written, the timer named in the badge's title. Then its memory
while it runs, and its word: a scheduled service is *Waiting* between two
runs, *Running* during one, *Last run failed* in attention, *Schedule
stopped* or *No timer* in error, with its last run ("Last run 3h ago",
"Failed 3h ago: exit code 1") and its next ("Next run in 42m") under it.
The column reads *Receives* when every service is a server, *How it runs*
otherwise.

**A site's Secrets.** Every write asks for the unlock when pressed, as
everywhere (5, *Writes and the unlock*). The owner's dialog, titled after
what waits or *Unlock changes*: "Enter the dashboard password to make
changes for 10 minutes."; a person's: "Sign in again with Google to make
changes for 10 minutes. Only what your roles allow." The
dashboard and the portal, which have no store, show their own files, the
owner's alone, in the **Files** panel: the service and *Restart service*, what
is wrong, then each file and its variables; a password variable offers only
*Change password*. Then **Activity**, that site's operations. Restarting the dashboard itself gives the
*Restarting* verdict: the dialog waits out the cut, reconnects by itself, then
asks you to unlock again.

A project with a store, every app but the dashboard and the portal, shows it
in one column (`components/secrets-store.tsx`):
**Variables**, its service and *Restart service* in the header with *Restore
previous version* for the owner and an Admin, then what needs attention, the
names and files `sitesolide.json` declares and the server lacks, flagged
first in red with *Set*, *Generate* or *Upload* each, then one row per
variable: its name, *Server* or *Not set*, *Declared* or *Not declared*, and
*Set*, *Generate* and *Remove* by the steward's `may`; *Add variable* at the
foot. A value is typed into *Set*'s dialog, never prefilled, or drawn on the
server by *Generate*, format and size chosen, never shown; over a value in
force, *Generate* reads *Replace* and says the old one stops working at the
next restart. Only the owner has *Reveal* and *Copy* on a row, for thirty
seconds: an Admin and a Developer read no value back, and the intro says so. **Files**: each file, *Set*, *Missing*, *Empty* (on the server
with nothing in it, which a service reads as missing) or *Unmanaged*, its size
to the owner alone, and the path every service reads it at,
`$CREDENTIALS_DIRECTORY/files_<name>`, with its copy button; *Upload* reads a
file in the browser and sends it base64. **Build, kept by whoever deploys**
and **Public, from the repository** list names, and the public values, for
reference, with no action. A unit that does not read the store yet says, as attention, to deploy or refresh the
project. The Overview's **Secrets** sums a store up in rows, its variables
counted set and not set, its files by name, never a variable's name.

**A site's Access.** Who can open the site, and what each person can do with
it, in one place, laid out like a "Share" dialog, in one column. Behind the
title's (i), one sentence, "Who can open cms, and what each person can do
with it here. Changes apply from each person's next visit."; the header's
*History* opens the log narrowed to the site's access changes
(`/activity/?target=cms&type=access`). Banners: an unlock
that failed; the portal on the server still reading its own lists, or unable
to read who has access (`sitesolide upgrade`); for the owner, company sign-in
not set up, so that everyone added gets password access, with where to set
it, the portal's `portal.env`.

**General access** first. For the owner and the project's Admins: Public,
Restricted and Anyone with the code, one sentence each, the current one
marked as the sidebar marks the current page, *Current* beside its name;
under Restricted, the paths "Open to anyone, guarded by the app alone"; under
Anyone with the code, the code and its link, to copy or open, and *New code*
beside them. Each other way has its button, *Make public*, *Restrict* or *Use
a code*, once the steward accepts; a choice it refuses says why under its
row, "it serves its own domain, riverside-cycles.example, which a code would
not close: switch it back to its preview first, sitesolide domain
--deactivate", and a reason that stops all three, a change in progress, is
said once under the choices. A disagreement between `sitesolide.json` and the
server is said above them in red, "Restricted in sitesolide.json, public on
the server. Anyone can open it right now. Choose one below."; each side is
then marked *On the server* or *In sitesolide.json*, *Keep Public* and *Apply
Restricted*, or *Apply Public* and *Keep Restricted*, and the third stays a
plain choice; a code on the server that sitesolide.json no longer asks for
reads *Apply Public* and *Keep Anyone with the code*. A Viewer or a Developer
reads general access in one line, "Restricted: only the people with access
can open it, once signed in. Only an Admin of cms, or the owner, changes
it.", the exempt paths under it, and for a site that opens with a code "An
Admin of cms, or the owner, has the code.": the code itself is the owner's
and the Admins'.

Restricting waits for no unlock; making public, using a code and a new code
do, then open their confirmation once unlocked. Making public and using a
code say first, in a red banner, what they open, "cms becomes public. Anyone
with its address can open it without signing in." or "cms opens to anyone
with its code. Anyone who has the code can open it, without signing in.",
then what they keep, and retype the slug; a new code says "The current code
stops working at once, and the link that carries it." and asks no typing;
leaving a code says "Its code stops working." first. A site already as asked
is left as it is, "already restricted: nothing to change". Restricting a site
nobody is on the list of warns "Nobody is on the list yet: after this, only
the owner and the admin emails can open wheels." All say "Takes up to a
minute. If anything fails, nothing changes."; the wait neither closes nor
cancels and shows the time elapsed on a minute and a half's scale; the result
says what the site now does, "wheels.example.com now asks visitors to sign
in. The 13 other sites still answer.", "calendar.example.com now opens
without signing in." or "cms.example.com now asks for its code.", with the
code and its link when there is one, then "Your next sitesolide deploy writes
this into sitesolide.json."

Then **People with access**, its count the number of rows, and while the site
is not restricted a note, "wheels is public, so anyone can open it. Viewer,
Developer and Admin still apply; Can open matters once you restrict it." For
the owner and the project's Admins, *Add people* at the top: an email or a
`@domain`, the domain only once company sign-in is set up, a role among those
the viewer may give, a plain *Can open* in place of the menu when it is the
only one possible, and for password access how long it lasts, 24 hours, 7
days, 30 days or no expiry. The line under the field says, before anything is
sent, what adding gives, or why not: someone who signs in with their company
account; everyone with an account at a domain; "acme.com isn't one of the
company's domains: they get password access, to open the site only.", with
its end; "Nobody at acme.com can sign in here: only example.com accounts can.
Add people from acme.com by email: they get password access.", with no *Add*;
"Already covered by @example.com."; "owner@example.com already opens every
site, as admin: it's set on the server."; "erin@example.com is already on the
list, as Viewer." *Add* carries the lock glyph when the role or the
password waits for the unlock, said under the field: "Giving Developer asks
to unlock changes first.", "Password access asks to unlock changes first." The
owner, once unlocked, finds the addition made; a person, back from signing in
again at their provider, finds the field and the role as they left them, and
"Unlocked. Press Add to finish." After adding, "dana@example.com can now open
cms." or "dana@example.com is now Viewer on cms.", with the line to send and
*Copy*, since no email is sent; raising someone from their row to Viewer or
above shows the same, and any other change of that row clears it; from Viewer up
it names the dashboard too, "calendar is at https://calendar.example.com/,
and in the dashboard at https://dashboard.example.com. Sign in with your
Google account.", and from Developer up adds "To deploy, create a token on
the Tokens page, then run sitesolide login --url
https://dashboard.example.com.";
for password access, a dialog with the address, the password and its end, and
*Copy message*. Under the field, *What each role can do*, a disclosure
open for everyone, the owner and Admins included, who give the roles: Can
open to Admin, each including the ones below it, the reader's own marked
*(your role)*. A Viewer or a Developer finds, in place of the field, whom to ask:
"To add someone, ask an Admin: bruno@example.com.", or "To add someone, ask
the owner."

Then one list, the same for every reader, controls only for those who manage
it: higher roles first, then people, domains and password access, what
expired last. Each row says who, *(you)* on one's own; what it is (everyone
at a domain, password access and its expiry, "Can't sign in until company
sign-in is set up.", for a person or a domain, "Can't sign in: acme.com isn't
one of the company's domains."); who added it and when, quietly, except on what was carried over;
its role in a menu when the viewer may change it, as a word otherwise,
greyed for someone who can't sign in, *Expired* greyed for a password access
that ended; and *Remove*, which confirms. A role raised once unlocked is
given at once. An Admin lowering or removing themselves is asked first:
"You'll no longer manage cms. Only another Admin or the owner can give it
back." Lowering someone to Can open, or removing them, when they keep no
role above Can open nor the create right, is asked first too, naming what
goes with it: "chloe@example.com will no longer sign in to the dashboard.
Also revokes 2 tokens: alice-ci (made by them), Alice's laptop (made by
you)." Under the list, one quiet line: "Also open
it: the owner, and owner@example.com (an admin email set on the server; sites
see them as admin).", or "The owner also opens it."

A project of the platform (portal, dashboard, api, analytics, landing, www,
and the landing named after the zone) shows one panel: how it opens, in one
line, then "portal is part of the platform. Only the owner opens it when
restricted; no one can be given a role on it."

**A site's Backups.** *Restore* asks for the unlock when pressed, like a
secret's write, then confirms. **Schedule**: how fresh the last snapshot is (the last
run's error in red, over two hours in attention), what the retention keeps,
the offsite copy, the last restore. **Snapshots**: the newest twelve, then *Show
all*, each with *Restore*, or the steward's reason not to under the title.
**Activity**: the runs and the restores. The confirmation lists what the server
does and makes you retype the slug; the wait shows the phase the steward reads
from the restore and the time elapsed on a five-minute scale, then the result,
which says how to undo it. A site with nothing to save says why, and what would
change it.

## 8. What was set aside

1. **Four "big number, small label" tiles** at the top: replaced by one plate
   where the thresholds are read on the gauges.
2. **A red brand**: the logo was a red seal, and beside a teal accent the two
   clashed; in a tool where red means error, it also said error at the top of
   every page. The logo moved into the accent's family, and red kept one
   meaning.
3. **A summary in three side-by-side cards**: what it said lives in the sites'
   rows.
4. **Monospace for what is typed in a terminal alone**, Graphite's rule: an
   address, a port or a version read as prose beside the landing page, which
   sets every machine string in Plex Mono. They are mono now, a slug, an email
   and a number staying in Hanken.
5. **Inter**, shadcn's font, then **widened Archivo** for titles, then
   **Geist** and Geist Mono for everything: the landing page moved to Hanken
   Grotesk and Plex Mono, and the dashboard follows it so that both read as
   one product.
6. **Tinted backgrounds on rows in discrepancy**: the icon already says it.
7. **Screen breakpoints**: the sidebar made any `lg:` rule wrong by one sidebar
   width (3.2).
8. **Machine-wide Secrets and password access pages**: everything about a
   site lives in that site.
9. **A ticked step bar while waiting for the gatekeeper**: the page does not
   know where it is, so it shows the elapsed time, ticking nothing.
10. **The plate dark in both themes**, the landing page's deep section carried
    into the page: in light it was the one dark object on the screen. A panel
    that follows the theme reads as one with the rest, and its ticks keep it
    remarkable.
11. **An ink primary, midnight blue on cold glass**: teal gives "here" a
    single colour, from the primary button to the focus ring and the
    sidebar's marker, and stays clear of the error red and of the three tones.
12. **Four sections for one question**: who opens a site, who signs in to it
    with a password, who signs in with their company account and who does
    what on it in the dashboard lived in four sections of a site, and two
    more pages at the machine level, each answering part of it in its own
    words. One *Access* section per site, read like a "Share" dialog, *People*
    across projects and *Tokens* answer it once each, in the words of one
    ladder of roles.
13. **Graphite**, the look before Ledger: neutral greys, white panels ruled by
    a pixel and no shadow on a page surface, Geist, the logo a petrol block
    with a hard offset shadow. Beside the landing page in Ledger it read as
    another product. The paper, the soft tiers, the pressable teal and the
    two faces are the landing page's own, held to this page's density.
14. **The landing page's six feature colours everywhere**: its coral and its
    amber would say error and attention in a page where those colours mean
    nothing else, and a feature colour on a surface larger than a chip turns
    a signal into a decoration. Three stay, for what is theirs.
15. **The landing page's 24 px panels and 44 px buttons**: drawn for a page you
    read once; at the dashboard's density they would cost a row in four. The
    panels take its cards' 14 px, the buttons its small sizes, 32 and 36 px.
    The sign-in alone keeps them, being such a page, and the portal's.
16. **An unlock button in every header**, *Unlock changes*, and *Unlock to
    ...* buttons in the panels under it: two controls for one gesture on six
    pages, the button primary on three and outline on the other three, and a
    header crowded with two pills and a button once unlocked. The unlock is
    asked for when a write is pressed, and one pill says it is open.
17. **An intro paragraph opening every page**: 40 to 60 px on each, the
    whole first phone screen of Activity, read once and then in the way of
    the list. It lives behind the title's (i), whole.
18. **An activity panel on an object's page**, Tokens twice, Secrets,
    Backups, Connectors: history at the weight of the object, mostly routine,
    "Scheduled run, Done" six times. Activity holds it, behind *History* and
    a sheet's *Recent*.
19. **A status word and a dot on every healthy row**, *Running* fourteen
    times, *Active* on every token: words that say nothing, which hid the
    one that did. The verdict says fine once; a row speaks when it is not.
20. **Rows as paragraphs**, 63 to 105 px with a made-by line, dotted actions,
    resource bars and a button each: the secondary facts went to the sheet,
    a tooltip or the row menu, and a row is one line.
21. **A tiled empty state inside a panel**, 190 px to say nothing is there:
    one line now, or no section at all.
22. **Filters as one segmented control mixing dimensions**, All, Issues,
    Apps, Static, Restricted and Platform side by side: one facet per
    dimension, its menu showing the rows' own icons and counts.

23. **A *May create projects* checkbox on every person's row**: a right
    given by a click while scrolling, in a column empty for nearly everyone,
    and a form for it under the list. The row's menu gives and takes it, a
    quiet tag says who holds it, and the form is the header's *Let someone
    create projects*.
24. **Domains in a panel of their own** under People: the same question,
    who gets in, answered twice. One list, its *Type* facet to narrow it.
25. **A Grants panel of every pair**, its count the grants' while its rows
    were the pairs, 3 over 6: a granted pair needs no decision. What waits
    is *Requests*, which counts its rows; a granted pair lives in its
    connector's row and sheet.
26. **Created, used and until in a token's row, its made-by line, Write-only
    on every connector**: the row keeps what a decision needs, Last used and
    Expires; the rest, and what is true of every connector, is in the sheet
    and the dialog.
27. **The New token dialog at its full height**: 1002 px of content in an
    868 px dialog, every project in two columns and four permissions always
    open. Six rows of projects with a filter, the permissions closed until
    one is on or needed, and a summary line in view of *Create token*.
28. **Who added a person, and when, in People's sheet**: the People route
    carries each person's roles, not who gave them. It is on the person's
    row in each project's Access section.

## 9. Seeing the page, and looking at it

```bash
cd dashboard
bun run build            # borrowed files, dependencies, page in public/
bun run page-bench       # http://localhost:4322, password demo
```

The bench runs the real `server.ts` on fictional data, a fake steward with
the real access and sign-in routes, a fake portal, and plays Caddy in front
of them. *Sign in with Google* leads to a page of the bench's that signs in
one of its people: alice@example.com, a Developer on `cms`, an Admin on
`calendar` and a Viewer on `photos`; bruno@example.com, an Admin on `cms`;
chloe@example.com, a Viewer on `calendar`; editor@example.com, Can open on
`cms`, whom the dashboard refuses with `can-open-only`; stranger@example.com,
on no list, refused with `no-role`. It seeds an expired password access on
`library`, and alice's token `alice-ci`, paused on `photos`, where she is a
Viewer now. Two projects serve no page: `courier`, a worker beside two
scheduled services, the hourly one's last run failed outside the showcase,
and `reports`, whose every service is scheduled. The platform's own three,
`dashboard`, `portal` and `analytics`, sit under Platform. Variants:
`BENCH_PORT`, `BENCH_STALE=1`, `BENCH_NO_STEWARD=1`, `BENCH_NO_PORTAL=1`,
`BENCH_NO_SSO=1` (no provider: everyone added gets password access),
`BENCH_NO_EGRESS=1`, `BENCH_NO_BACKUPS=1`, `BENCH_OLD_STEWARD=1`,
`BENCH_EMPTY=1`, `BENCH_FRESH=1` (the platform's own projects alone, all
well), `BENCH_PLATFORM_DOWN=1` (the portal's unit failed, alone or with
`BENCH_FRESH=1`), `BENCH_SHOWCASE=1`. After `bun run web:build`, a reload is
enough.

**The pattern gallery**, for whoever builds a screen: every shared pattern
drawn by the real components with fictitious rows, inside the real shell
and signed in against the bench, its sheet's *Recent*, its History links and
its unlock the bench's own. The header and its (i), the FilterBar and the
DataTable in both layouts, dense rows and the row's one action, quiet when
fine, the icons and their tooltips, the writes and the unlock, the empty
states, the banners, the sheet. It is built only when asked, so that it
never ships:

```bash
cd dashboard
DASHBOARD_GALLERY=1 bun run build
bun run page-bench       # http://localhost:4322/gallery/, password demo
```

A visible change is looked at before being shipped, through headless Chrome
screenshots of the bench, in light and in dark:

- the home page, Activity, People and Tokens; the home page under Platform,
  on a fresh machine (`BENCH_FRESH=1`) and with the portal down
  (`BENCH_PLATFORM_DOWN=1`); the five sections of a site,
  the Overview of a service in a restart loop and of a locked static site,
  of `courier` and of `reports`,
  the Secrets of a site with a store, and of the dashboard itself;
- at 1440 px, at 1024 px with the sidebar expanded, and at 390 px;
- the collapsed sidebar, the switcher open, sign-in, an expired session, Secrets
  unlocked, the new token dialog;
- Access as the owner, as an Admin and as a Viewer; *Add people* with a
  company account, a domain and someone who gets password access, locked and
  unlocked; the password dialog; making a site public, its confirmation, the
  wait and the success, the restored failure; a site that opens with a code,
  as the owner, an Admin and a Viewer; *Use a code* and *New code*, their
  confirmation, the wait and the code shown;
  a platform project;
- a person's shell, signed in through the bench's provider page, as a
  Viewer, a Developer and an Admin; the sign-in refusals, as
  editor@example.com and stranger@example.com;
- the outages, on a second bench with `BENCH_NO_STEWARD=1
  BENCH_NO_PORTAL=1`, and company sign-in not set up with `BENCH_NO_SSO=1`.

Compare them from page to page: same header, same content width, same panel
titles, same words for the same states.
