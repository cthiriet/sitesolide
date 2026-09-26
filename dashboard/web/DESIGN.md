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

The personality comes from the landing page: midnight-blue ink on cold glass,
one red, the one from the logo's seal, and widened Archivo for titles. The only
remarkable piece is **the machine plate** at the top of the home page, where the
70 and 90 % thresholds are engraved on each gauge. Everything else is calm,
dense and aligned.

1. **The verdict first.** Every page carries, in the same place, the machine's
   verdict and the age of the data. A stale snapshot never says "All clear".
2. **Red means error, and nothing else.** Neither a link, nor the current page,
   nor a focus ring is red.
3. **Structure carries information.** A rule separates the rows of a list, a
   white surface groups what is read together, a tick on a gauge marks a
   threshold. No decorative frames, numbers or labels.
4. **Panels, not stacked cards.** One panel per readable set, divided lists
   inside.
5. **Dense without being cramped.** Rows of 40 to 44 px on a computer, 40 to
   44 px touch targets, tabular figures wherever numbers are compared.
6. **Nothing moves without a reason.** No entrance animation; only what answers
   a gesture moves, and nothing under `prefers-reduced-motion`.
7. **A write is a decision.** A button that writes says exactly what it will do.

## 2. Tokens

All in `src/styles/global.css`, under `:root` (light) and `.dark`. A component
**never** writes a hex value or a Tailwind palette colour (`amber-500`,
`emerald-700`): it names a token.

### 2.1 Colours

| Token (class) | Light | Dark | Role |
|---|---|---|---|
| `background` | `#e8ecf1` glass | `#0e1726` ink | page and sidebar background |
| `foreground` | `#0e1726` | `#e6eaf1` | text |
| `card`, `popover` | `#ffffff` | `#131f35`, `#172440` | panels; menus and dialogs |
| `muted`, `secondary`, `accent` | `#dfe4eb` | `#1a2842` | table headers, hover, neutral pill |
| `muted-foreground` | `#56637a` | `#9aa8c4` | meta, help text, column headers |
| `primary` | `#0e1726` | `#e6eaf1` | the primary button, in ink |
| `border` | `#d2d9e3` | `#25324b` | rules and borders |
| `input` | `#c5cedb` | `#2e3c57` | field edges |
| `ring` | `#5b6c92` | `#9aa8c4` | focus ring, stratum blue |
| `destructive` | `#b3253f` | `#f36f84` | errors, and only errors |
| `plaque` | `#131f35` | `#131f35` | the machine plate, dark in both themes |
| `sidebar-accent` | `#ffffff` | `#131f35` | the current page in the sidebar |

Measured contrasts (WCAG), to check again after any change:
`muted-foreground` 6.1:1 on white and 5.1:1 on glass, 6.9:1 on `card` in dark;
`destructive` 6.5:1 on white, 5.8:1 on `card` in dark.

### 2.2 Status tones

Four tones, not one more, from the `Tone` type in `lib/tones.ts`. Their classes
are spelled out there (`TONE_DOT`, `TONE_TEXT`, `TONE_PILL`, `TONE_BANNER`),
and `tests/tones.test.ts` checks that they only name tokens.

| Tone | Dot (solid) | Text | Meaning |
|---|---|---|---|
| `ok` | `bg-ok` | `text-ok-text` | running, up to date |
| `attention` | `bg-attention` | `text-attention-text` | worth a look: 70 % threshold, restart pending, expiry near |
| `error` | `bg-destructive` | `text-destructive` | to deal with: service not running, door in disagreement, 90 % threshold |
| `neutral` | `bg-muted-foreground` | `text-muted-foreground` | information, without judgement |

Each tone's text clears 4.9:1 on its tinted pill, in both themes. Colour never
carries meaning alone: a dot comes with a word, a severity icon with text for
screen readers. `severityTone` gives a discrepancy's tone, `verdictTone` the
verdict's (a stale snapshot is an error).

### 2.3 Typography

One family, **Archivo Variable**, served from `_assets/` with no third-party
request. `font-display` is the same family at `font-stretch: 118%`. A system
monospace **only for what is typed into a terminal**: file name, variable name,
lock code, path, unit, command. A slug, an address or a number is not
monospace.

| Role | Classes |
|---|---|
| Page title (`h1`) | `font-display text-[1.375rem] leading-7 font-semibold tracking-tight` |
| Gauge figure | `font-display text-[1.75rem] leading-8 font-semibold tabular-nums` |
| Panel title (`h2`) | `text-sm font-semibold` |
| Body text, cells | `text-sm` |
| Meta, column headers, help | `text-xs text-muted-foreground` |
| Wordmark in the sidebar | `font-display text-[0.9375rem] font-semibold` |

No label capitals, no letter spacing (except a lock code), no single word in a
different colour inside a title. Every number that gets compared is
`tabular-nums`.

### 2.4 Spacing, widths, radii

- 4 px base. Page gutter `px-4`, then `md:px-8`.
- Content in `max-w-6xl` (1152 px), centred to the right of the sidebar.
- Between two blocks of a page, `gap-6`. Inside a panel, rows `px-4 py-2.5`
  (dense list) or `py-3` (two-level row).
- Bottom padding `pb-28` on a phone, to clear the tabs.
- `--radius: 0.5rem`, and the more containing the object, the more containing
  its radius: plate and dialogs `rounded-xl`, panel, table and banner
  `rounded-lg`, pill and counter `rounded-sm`, dot `rounded-full`. **A control
  keeps its shadcn component's radius** (8 px at default size, 6 px in `sm`),
  with no override; a hand-drawn control takes a field's.
- No shadow on a page surface: they separate by colour and a rule. Only menus,
  tooltips and dialogs have a shadow.

## 3. Layout

### 3.1 The shell

```
Computer (>= 768 px), machine level
+--------------+-----------------------------------------------------------+
| sitesolide   | Sites 13                * 3 errors, 3 warnings  26s  [R]  |  sticky header
|              +-----------------------------------------------------------+
| Sites      6 | [Banner: Can't reach the dashboard / collector stale]     |
| Activity     |                                                           |
|              |   plate, Issues, search and filters, list of sites        |
| Dark mode    |                                                           |
| Sign out     |                                                           |
| Collapse  ^B |                                                           |
+--------------+-----------------------------------------------------------+

Phone (< 768 px), inside a site
+------------------------------------+
| logo All sites > cms       [R] [.] |
|      Secrets (switch site)         |
| * 3 errors, 3 warnings  26s        |
| [page actions]                     |
+------------------------------------+
|  content, px-4                     |
+------------------------------------+
| Overview  Secrets  Guests  Access  |  mobile tabs, fixed, h-16
+------------------------------------+
```

The sidebar is the shadcn `sidebar` component (`collapsible="icon"`). Collapsed
with `Cmd+B`, `Ctrl+B` or its button: icons only, a tooltip, a tone dot on the
icon when the indicator is `attention` or `error`. The state lives in
`localStorage["sidebar-collapsed"]`, read back before the first render by an inline
script. The current page is a white surface, never a colour; on a phone, a 2 px
rule above the tab.

**Two levels.** On the home page and on Activity, the sidebar carries the
machine's pages. Inside a site it becomes that site's: the *All sites* return,
the current site on a white surface (initial, name, state in one sentence, tone
dot), which opens the site switcher, then its four sections. Collapsed, the site
is just its initial and its dot. On a phone the tabs follow the level: two for
the machine, four for a site.

Indicators (`lib/sidebar.ts`). Machine: *Sites* the number of discrepancies (error
if there is one, otherwise attention). Site: *Overview* its discrepancies;
*Secrets* what its files ask for, missing as an error, unmanaged or restart
pending as attention; *Guests* its active accesses (neutral); *Access* a door in
disagreement (error). Zero is not shown.

### 3.2 The screen decides the shell, the container decides the content

**One rule, no exception**: everything laid out inside the content, columns,
table or list, follows its container's width through an `@container` query,
never the screen's. The expanded sidebar takes 256 px: at 1024 px the content
has only 704, and an `lg:` rule would put two 340 px columns there. The screen
(`md`, 768 px) decides only the shell: sidebar or tabs, header arrangement,
gutters, bottom margin, touch target size.

| Container | Threshold | What changes |
|---|---|---|
| `@container/body` | `@4xl/body:` (56 rem) | two columns: a site's Overview, Access |
| list of sites on the home page | `@4xl:` | table, otherwise list |
| Guests panel, Activity panel | `@2xl:` (42 rem) | table, otherwise list |
| machine plate | `@2xl:` | four columns, otherwise three rows |
| Issues panel | `@lg:` (32 rem) | messages aligned behind the slugs |
| `@container/file` | `@xl/file:` (36 rem) | Name, Value and action columns |

Useful content widths: 1088 px at 1440 with the sidebar expanded, 960 at 1280,
912 at 1024 collapsed, 704 at 1024 expanded, 358 on a phone.

### 3.3 The page header

`PageHeader` is the first element of every page. It carries the focusable `h1`,
a count, the breadcrumb above the title, what follows the title on its line, a
description under it, the page actions, then on the right the verdict (a link to
the home page when not on it), the age and the refresh control. On a phone the
verdict and the age move under the title, the actions below that. Page-wide
banners follow the header.

- **Title.** The home page is called *Sites*. Inside a site, Overview carries
  the slug, the other sections their name, and the breadcrumb says
  *All sites > cms*.
- Page actions: default-size button (`max-md:h-10`), one primary only. State
  pills beside it at `h-6`, like the verdict.
- Panel actions: `size="sm"`.
- An action does not appear until what it presupposes has been read: *Create
  access* waits for the portal's list, *Unlock* and *Turn on portal* for the
  steward's.

## 4. The primitives

A page does not write its own version of any of them.

### 4.1 Data and navigation

| Name | File | Use |
|---|---|---|
| `useData()` | `data.tsx` | everything the pages read: snapshot, verdict, age, secrets, guests, `sessionExpired`, `refresh` |
| `useNavigation()` | `navigation.tsx` | `{ page, params, fromHistory, navigate(href, { replace? }) }` |
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
| `SitePage` | a site's section: header with breadcrumb and switcher, body, "No site named x" for an unknown slug |
| `Panel` | a bordered surface; with `title`, a 44 px header row; `full` for a table or list that touches the edges |
| `WithSnapshot` | loading, dashboard unreachable, snapshot incomplete, rendered the same everywhere |
| `EmptyState` | nothing to show: the title states the state, the text says what to do |
| `ErrorState` | a page-specific read failed and there is nothing else: a title naming what did not answer, advice and a command, *Retry* |
| `Banner` | a problem that does not stop you reading: kept data, a site's discrepancy, a refused removal |
| `RowsSkeleton`, `PanelSkeleton` | a load, shaped like what it replaces, `aria-busy` on its container |

The header always shows, only the content becomes a skeleton; no "Loading" text
on screen.

### 4.3 Statuses and small elements

| Name | Rule |
|---|---|
| `Status` | a dot and a word. `point` in lists and tables, `pill` for what has to be seen from afar |
| `SeverityIcon` | crossed circle (error) or triangle (warning) before a discrepancy, with hidden text |
| `Count` | the number beside a title |
| `ExternalLink` | a site address, underlined at rest, in a new tab |
| `MachinePlate`, `Track` | the plate, reserved for the home page; `Track` reused for a service's memory |
| `Track` (dialogs) | waiting for a long answer: the time actually elapsed on its scale, the usual duration engraved when known, never an invented progress bar |
| `Command` | a command to type in a terminal, copyable |
| `serviceWord` | the word and tone of a systemd unit, the same on the home page, the Overview and Secrets |

shadcn components available in `src/components/ui/`: `alert`, `alert-dialog`,
`badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`,
`progress`, `separator`, `sheet`, `sidebar`, `skeleton`, `table`, `tooltip`.
Add with `bunx --bun shadcn@latest add <name>`; a generated component is not
edited, it is varied through `data-slot` or wrapped.

## 5. Content rules

**Tables and lists.** A table lives in a `Panel full` and becomes a divided
list below the width it needs (3.2). Header
`h-9 bg-muted/50 text-xs font-medium text-muted-foreground`, cells
`px-3 py-2.5`, first column `pl-4`, last `pr-4`, numbers right-aligned.
`caption` in `sr-only` stating the order and the filter. A row in discrepancy
carries the `SeverityIcon` before the name, with no tinted background.

**A row that leads to a page**: the name is the real link, the one for the
keyboard and for screen readers; the rest of the row follows the click in code,
so an address stays selectable. Cmd, Ctrl and the middle button open a new tab.

**A section with nothing in it stays open** and says why and what to do: Guests
of a site with no portal leads to Access, Secrets of a site with no file says to
declare `secrets` in `sitesolide.json` and then run `sitesolide deploy`.

**Buttons.** One primary per view, in ink. `destructive` is used only for a
confirmation's action. A button in progress says what it is doing:
*Revoking...*, *Saving...*.

**Dialogs.** `Dialog` to type into (anchored at the bottom on a phone), or for
an action that waits a long time for its answer; `AlertDialog` to confirm. A
wait in progress neither closes nor cancels: the server sees it through. A title
naming the object, a description stating the consequence, the primary action on
the right. Focus goes to the first field, then back to the originating element.

**Errors.** Say what did not answer and what to do, without apologising: "Can't
reach the portal." then the command to run. Under the offending field
(`role="alert"`), in a `Banner` when the page stays readable, in an
`ErrorState` when there is nothing to show.

**Search and filters.** In a toolbar under the header, on the left. `/` focuses
the site search, Escape clears it then returns focus. The count and the order on
the right: "3 of 13 sites, issues first".

**Secrets and passwords.** A field that receives a secret is `type="password"`,
`autoComplete="off"`, `data-1p-ignore`; a textarea, which cannot be, is masked
with `[-webkit-text-security:disc]` plus *Show*. A revealed value lasts thirty
seconds and is masked again on locking, tab hidden, page left, site or section
changed. A write-only file offers neither *Reveal* nor *Copy* and says so; a
password variable offers only *Change password*. A drawn password is shown once,
with its copy button.

**Keyboard and announcements.** `focus-visible:ring-3 ring-ring/50` everywhere.
After a navigation: scroll to top (except on back), focus on the `h1`, title
announced, tab title updated. One `aria-live` region, through which a password
or a value never passes. Under the sign-in of an expired session, the page is
`inert`.

## 6. Vocabulary

| Object | Word | Do not write |
|---|---|---|
| Machine pages | Sites (the home page), Activity | Dashboard, Home, Overview |
| Site sections | Overview, Secrets, Guests, Access; the breadcrumb *All sites > cms*; *Switch site* | Settings, Details |
| The machine | Server | VM, host |
| Discrepancy | Refusal, issues; Error, Warning | Alert, Critical |
| Verdict | All clear, `N errors, N warnings`, Stale data, No data | OK, Healthy |
| Age | Updated 26s ago, just now | Last sync |
| Service | Running, Starting, Restarting, Stopping, Down; Static files, No manifest; Unknown | Up, Offline, Dead |
| Door | Preview lock, Portal, No gate; Portal on, Portal off; Turn on portal, Turn off portal; Public paths | Password protected, Enable, Disable |
| Secrets | Locked, Unlocked, Unlock, Lock, Restart pending, Unmanaged, Missing, Write-only, Restart service, Restore previous, Add variable, Create file, Replace, Reveal | Vault, Decrypt, Edit file |
| Passwords | Change password, Dashboard password, Generate a strong one, Set my own, New password, Copy password | Set hash, Regenerate |
| Guests | Guest, access, Create access, Revoke, Remove, Expires, Last visit, No expiry | New access, User, guest link |
| Unreachable | Can't reach the dashboard., Can't reach the portal., Can't reach the steward. | is not answering |
| Common actions | Refresh, Retry, Sign in, Sign out, Copy, Copied, Cancel, Close, Manage | Reload, Try again, Log out, Submit |
| Empty states | No issues, No sites match "x", No guest access to cms yet, cms has no secret files, cms isn't behind the portal | Nothing here! |

Active voice, sentence case, no exclamation marks.

## 7. The pages

One page per served file, the site in `?s=`:

| Page | Address | File |
|---|---|---|
| Sites, the home page | `/` | `index.html` |
| Activity | `/activity/` | `activity/index.html` |
| A site's Overview | `/site/?s=cms` | `site/index.html` |
| A site's Secrets | `/site/secrets/?s=cms` | `site/secrets/index.html` |
| A site's Guests | `/site/guests/?s=cms` | `site/guests/index.html` |
| A site's Access | `/site/access/?s=cms` | `site/access/index.html` |

Older addresses keep their file and redirect client-side, with no history entry.
A section without `?s=` goes to the home page.

**Sites (the home page).** The machine plate (memory, disk, load, with their
ticks at 70 and 90 %), the Issues panel, errors first, then the search, the
filters (All, Issues, Apps, Static, Portal, each with its count) and the
inventory, sites in discrepancy at the top: Site, Address, Access, Service,
Size. Summaries live in the rows, not in cards.

**Activity.** The lock in the header, then the steward's latest operations
across the whole machine, unlocks included, with no values.

**A site's Overview.** Under the title, the state in one sentence, the
description and the main address; its discrepancies as banners. Then two
columns: on the left the site on the machine, **Service**, **Addresses**,
**Storage**; on the right what opens it and what it keeps, **Access**,
**Guests** and **Secrets**, each with *Manage >* to its section.

**A site's Secrets.** The lock in the header. The **Files** panel: the service
and *Restart service*, what is wrong, then each file. A variables file lists its
variables; a password variable offers only *Change password*. A file read whole
states its size and offers *Replace*, and *Reveal* if it is readable. Then
**Activity**, that site's operations. Restarting the dashboard itself gives the
*Restarting* verdict: the dialog waits out the cut, reconnects by itself, then
asks you to unlock again.

**A site's Guests.** *Create access* in the header, the site already chosen. The
table: active ones by expiry, then expired ones under their subheading. With no
portal, the empty state leads to Access.

**A site's Access.** Two panels. **Portal**: its state, `sitesolide.json` and
the server side by side, the public paths, and *Turn on portal* or *Turn off
portal* if the steward accepts, its reason otherwise. The confirmation states
the gatekeeper's three steps and the rollback on failure; a removal warns that
the site becomes public and makes you retype the slug. **Preview lock**: the
code and its link, and the `bin/lock.sh` commands that set, change or remove it,
the dashboard not writing there.

## 8. What was set aside

1. **Four "big number, small label" tiles** at the top: replaced by one plate
   where the thresholds are read on the gauges.
2. **The seal red as an accent**: it would have shouted everywhere in a tool
   where red means error.
3. **A summary in three side-by-side cards**: what it said lives in the sites'
   rows.
4. **Every identifier in monospace**: it is kept for what is typed in a
   terminal.
5. **Inter**, shadcn's font: Archivo, the brand's.
6. **Tinted backgrounds on rows in discrepancy**: the icon already says it.
7. **Screen breakpoints**: the sidebar made any `lg:` rule wrong by one sidebar
   width (3.2).
8. **Global Secrets and Guests pages**: everything about a site lives in that
   site.
9. **A ticked step bar while waiting for the gatekeeper**: the page does not
   know where it is, so it shows the steps and the elapsed time, ticking
   nothing.

## 9. Seeing the page, and looking at it

```bash
cd dashboard
bun run build            # borrowed files, dependencies, page in public/
bun run page-bench       # http://localhost:4322, password demo
```

The bench runs the real `server.ts` on fictional data, a fake steward, a fake
portal, and plays Caddy in front of them. Variants: `BENCH_PORT`,
`BENCH_STALE=1`, `BENCH_NO_STEWARD=1`, `BENCH_NO_PORTAL=1`, `BENCH_EMPTY=1`.
After `bun run web:build`, a reload is enough.

A visible change is looked at before being shipped, through headless Chrome
screenshots of the bench, in light and in dark:

- the home page and Activity; the four sections of a site, the Overview of a
  service in a restart loop and of a locked static site, the Secrets of a site
  with a write-only file and a subdirectory, and of the dashboard itself;
- at 1440 px, at 1024 px with the sidebar expanded, and at 390 px;
- the collapsed sidebar, the switcher open, sign-in, an expired session, Secrets
  unlocked, the create-access dialog;
- Access: the confirmation of a removal, the wait and the success, the restored
  failure;
- the outages, on a second bench with `BENCH_NO_STEWARD=1
  BENCH_NO_PORTAL=1`.

Compare them from page to page: same header, same content width, same panel
titles, same words for the same states.
