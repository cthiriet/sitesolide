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

The look is **Graphite**: neutral greys, one family, Geist, and one colour
family, petrol, which is the brand's: the logo is a petrol gradient around the
accent, and the accent marks what is current or in focus. Red is the error
colour, not the brand's, and it only says error. The only remarkable piece is
**the machine plate** at the top of the home page, where the 70 and 90 %
thresholds are ticked on each gauge. Everything else is calm, dense and
aligned.

1. **The verdict first.** Every page carries, in the same place, the machine's
   verdict and the age of the data. A stale snapshot never says "All clear".
2. **Red means error, and nothing else.** Neither a link, nor the current page,
   nor a focus ring is red. **Petrol means "here"**: the current page, the
   focused element, a gauge's fill, the primary button; never a state.
3. **Structure carries information.** A rule separates the rows of a list, a
   bordered card groups what is read together, a tick on a gauge marks a
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
| `background` | `#f7f8fa` | `#0a0b0d` | page and sidebar background |
| `foreground` | `#16181d` | `#e7e9ec` | text |
| `strong` | `#0a0b0d` | `#ffffff` | what is current or chosen: the sidebar's page, a selected filter, a site's name |
| `secondary-foreground` | `#3a404a` | `#c9cdd3` | text a step below the body: navigation, the filters not chosen, a counter |
| `muted-foreground` | `#5f6672` | `#8b9098` | meta, help text, column headers |
| `card`, `popover` | `#ffffff` | `#111316`, `#16181c` | panels; menus and dialogs |
| `muted`, `secondary`, `accent` | `#eceef2` | `#16181c` | hover, table header, a selected segment, the neutral pill |
| `border` | `#e3e6eb` | `#1f2227` | a panel's frame, a header's rule, a counter's fill |
| `divider` | `#edeff2` | `#1a1c20` | the rule between two rows of a list or a table |
| `input` | `#d9dde3` | `#23262c` | field edges |
| `primary`, `ring` | `#0b6e79` | `#4cb8c4` | petrol: the primary button, the focus ring, the sidebar's marker, a gauge's fill |
| `primary-foreground` | `#ffffff` | `#0a0b0d` | text on the primary button |
| `highlight` | `#e7f3f4` | `#0e2427` | the accent's palest tint: the current page in the sidebar |
| `mark-from`, `mark-to` | `#138896`, `#0a5560` | `#5cc8d3`, `#2c98a4` | the logo's gradient, top left to bottom right |
| `track`, `tick` | `#e3e6eb`, `#8e95a1` | `#1f2227`, `#5e6572` | a gauge's empty bar, its threshold ticks |
| `destructive` | `#b3253f` | `#f36f84` | errors, and only errors |
| `sidebar-accent`, `sidebar-primary` | as `muted`, `primary` | as `muted`, `primary` | a hover in the sidebar, and the current page's marker |

**The brand is one petrol ramp**, one hue (185 to 188 degrees) in four steps:
`highlight`, the palest, for a surface that says "here"; `mark-from`, a step
lighter than the accent; `primary`, the accent; `mark-to`, a step deeper. The
logo's gradient brackets the accent, so the logo, the sidebar's marker and the
primary button read as one colour, in both themes. Dark lifts the accent and
the logo's steps, so that the deep end does not sink into the page, and turns
the tint into a deep petrol surface. The logo writes its stops as
`var(--mark-from)` and `var(--mark-to)`; the favicon, the portal's page and
`docs/assets` repeat the hex values, which cannot read a token, and change
with them.

Measured contrasts (WCAG), to check again after any change. Light:
`foreground` 17.8:1 on `card`; `secondary-foreground` 10.4:1 on `card`;
`muted-foreground` 5.8:1 on `card`, 5.4:1 on `background` and 5.0:1 on `muted`;
white on `primary` 6.0:1; `primary` as a ring, a marker or a fill 6.0:1 on
`card`, 5.1:1 on `muted` and 4.8:1 on the track; `destructive` 6.5:1 on `card`;
a tick 3.0:1 on `card`. Dark: `foreground` 15.3:1 on `card`;
`muted-foreground` 5.8:1 on `card`; near black on `primary` 8.4:1; `primary`
7.9:1 on `card`; `destructive` 6.6:1 on `card`; a tick 3.2:1 on `card` and
3.0:1 on `popover`. On `highlight`: `strong` 17.4:1 in light and 16.2:1 in
dark, `muted-foreground` 5.1 and 5.0:1, the `primary` marker 5.3 and 6.9:1,
an error count 4.9 and 5.0:1 on its pill. The logo, as a graphic: `mark-from`
4.0:1 on `background` in light, `mark-to` 8.0:1; in dark 10.0 and 5.8:1. The
full list is in the comment of `styles/global.css`.

One pair stays short, in a passing state: the primary button's hover,
`primary/80` from the generated `button`, puts white at 3.95:1 in light. A
generated component is not edited, and petrol dark enough to hold 4.5:1 there
would no longer be the chosen petrol.

### 2.2 Status tones

Four tones, not one more, from the `Tone` type in `lib/tones.ts`. Their classes
are spelled out there (`TONE_DOT`, `TONE_TEXT`, `TONE_PILL`, `TONE_BANNER`),
and `tests/tones.test.ts` checks that they only name tokens.

| Tone | Dot (solid) | Text | Light, dot and text | Dark, dot and text | Meaning |
|---|---|---|---|---|---|
| `ok` | `bg-ok` | `text-ok-text` | `#22a05a`, `#1e7a43` | `#3fb950`, `#7ee2a0` | running, up to date |
| `attention` | `bg-attention` | `text-attention-text` | `#b0790a`, `#8a5a00` | `#e3b341`, `#f2c55c` | worth a look: 70 % threshold, restart pending, expiry near |
| `error` | `bg-destructive` | `text-destructive` | `#b3253f` | `#f36f84` | to deal with: service not running, general access in disagreement, 90 % threshold |
| `neutral` | `bg-muted-foreground` | `text-muted-foreground` | `#5f6672` | `#8b9098` | information, without judgement |

Each tone's text clears 4.5:1 on its tinted pill, in both themes: in light
`ok-text` 4.8:1, `attention-text` 5.2:1 and `destructive` 5.5:1 over `card`,
the tightest being `ok-text` at 4.5:1 over `background`; in dark beyond 5.8:1.
Every dot clears 3:1 on `card` and on `background`, and the attention fill 3:1
on the track: the mockup's amber, `#c98a0b`, did not (2.4:1 on the track), so
it moved to `#b0790a`. Colour never carries meaning alone: a dot comes with a
word, a severity icon with text for screen readers. `severityTone` gives a
discrepancy's tone, `verdictTone` the verdict's (a stale snapshot is an
error).

### 2.3 Typography

One family, **Geist Variable**, for everything, titles included, served from
`_assets/` with no third-party request (`@fontsource-variable/geist`). **Geist
Mono** (`@fontsource-variable/geist-mono`) **only for what is typed into a
terminal**: file name, variable name, lock code, path, unit, command. A slug,
an address or a number is not monospace, nor is a key in a `kbd`.

| Role | Classes |
|---|---|
| Page title (`h1`) | `text-xl font-semibold tracking-title` (20/28 px, -0.02 em) |
| Gauge figure | `text-2xl leading-7 font-semibold tracking-title tabular-nums` (24/28 px) |
| Panel title (`h2`) | `text-sm font-semibold` |
| Body text, cells | `text-sm` (14/20 px) |
| Meta, column headers, help, a gauge's heading | `text-xs text-muted-foreground` (12 px) |
| Wordmark in the sidebar | `text-sm font-semibold tracking-[-0.01em]`, the zone below in `text-xs text-muted-foreground` |

`tracking-title` is a theme token in `styles/global.css`. No label capitals,
no letter spacing (except a lock code), no single word in a different colour
inside a title. Every number that gets compared is `tabular-nums`.

### 2.4 Spacing, widths, radii

- 4 px base. Page gutter `px-4`, then `md:px-8`.
- Content in `max-w-6xl` (1152 px), centred to the right of the sidebar.
- Between two blocks of a page, `gap-6`. Inside a panel, rows `px-4 py-2.5`
  (dense list) or `py-3` (two-level row, and every table row).
- Bottom padding `pb-28` on a phone, to clear the tabs.
- Radii in whole pixels, the more containing the object, the more containing
  its radius: plate, panel, table and dialog `rounded-xl` (12 px), a control
  and a banner `rounded-lg` (8 px), a pill, a badge and a filter segment
  `rounded-md` (6 px), a counter, a `kbd` and inline code `rounded-sm` (4 px),
  a dot `rounded-full`. **A control keeps its shadcn component's radius** (8 px
  at default size, 6 px in `sm`), with no override; a hand-drawn control takes
  a field's. A shadcn `Badge` is a pill: it takes `rounded-md` through its
  `className`.
- One pixel borders, no shadow on a page surface: they separate by a rule.
  Only menus, tooltips and dialogs have a shadow.

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
| * 3 errors, 3 warnings  26s        |
| [page actions]                     |
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
by an inline script. The current page takes the `highlight` tint, `strong`
text and a 2 px petrol bar on its left edge, where a hover only takes the
`muted` grey; on a phone, a 2 px petrol rule above the tab. The sidebar's own
controls (theme, sign out, collapse) sit at its foot in `muted-foreground`.

**Two levels.** On the machine's pages (Sites, Activity, People, Tokens,
Connectors), the sidebar carries them. Inside a site it becomes that site's: the *All sites*
return, the current site on a bordered card (initial, name, state in one
sentence, tone dot), which opens the site switcher, then its five sections,
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
| Viewer | Overview, Audience, Access, read only |
| Developer | Overview, Audience, Secrets, Access |
| Admin | all five |

Their email sits above the sidebar's own controls, in `muted-foreground`. A
page of the owner's, reached by its address, says *Only the owner's* in an
empty state rather than an error, and a section their role does not open,
*Not part of your role*: the service refuses both too.

Indicators (`lib/sidebar.ts`). Machine: *Sites* the number of discrepancies (error
if there is one, otherwise attention); Activity, People, Tokens and
Connectors report nothing. Site: *Overview* its discrepancies; *Secrets* what
its files ask for, missing as an error, unmanaged or restart pending as
attention; *Access* its general access disagreeing with `sitesolide.json`
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
| `@container/body` | `@4xl/body:` (56 rem) | two columns: a site's Overview, Audience and Access; Tokens' deployments and activity |
| list of sites on the home page | `@4xl:` | table, otherwise list |
| a site's Activity panel (Secrets, Backups), the Connectors lists | `@2xl:` (42 rem) | table, otherwise list |
| the People list | `@2xl:` | three columns under a header, *May create projects* said once there; otherwise the right under the roles, with its label |
| the machine's Activity log, five columns | `@3xl:` (48 rem) | table, otherwise list |
| Activity filters | `@4xl/body:` (56 rem) | five fields on one row, otherwise two columns |
| machine plate | `@2xl:` | four columns, otherwise four rows |
| Issues panel | `@lg:` (32 rem) | messages aligned behind the slugs |
| `@container/file` | `@xl/file:` (36 rem) | Name, Value and action columns |

Useful content widths: 1088 px at 1440 with the sidebar expanded, 984 at 1280,
912 at 1024 collapsed, 728 at 1024 expanded, 358 on a phone.

### 3.3 The page header

`PageHeader` is the first element of every page. It carries the focusable `h1`,
a count, the breadcrumb above the title, what follows the title on its line, a
description under it, the page actions, then on the right the verdict (a link to
the home page when not on it), the age and the refresh control. On a phone the
verdict and the age move under the title, the actions below that. Page-wide
banners follow the header.

- **Look.** A sticky band in the page's colour, ruled below, at least 68 px
  tall on a computer like the sidebar's header. The verdict stays on the right
  on every page: there it reads as the machine's, where beside a site's title
  it would read as that site's state.
- **Title.** The home page is called *Sites*. Inside a site, Overview carries
  the slug, the other sections their name, and the breadcrumb says
  *All sites > cms*.
- Page actions: default-size button (`max-md:h-10`), one primary only. State
  pills beside it at `h-6`, like the verdict.
- Panel actions: `size="sm"`.
- An action does not appear until what it presupposes has been read: the
  lock waits for the secrets, *Add people* and the role menus for the list of
  people with access, *Make public* and *Restrict* for the steward's word on
  whether the site may change.

## 4. The primitives

A page does not write its own version of any of them.

### 4.1 Data and navigation

| Name | File | Use |
|---|---|---|
| `useData()` | `data.tsx` | everything the pages read: snapshot, verdict, age, secrets, who is signed in (`identity`), `sessionExpired`, `refresh` |
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
| `Panel` | a bordered card, `rounded-xl`; with `title`, a 44 px header row; `full` for a table or list that touches the edges |
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
| `Count` | the number beside a title, `secondary-foreground` on the `border` grey |
| `ExternalLink` | a site address, underlined at rest, in a new tab |
| `MachinePlate`, `Track` | the plate, reserved for the home page: one bordered panel, the server (its zone, cores, memory and disk) then load, memory and disk; `Track` is a 6 px bar with a 1 px tick across it at each threshold, reused for a service's memory |
| `Track` (dialogs) | waiting for a long answer: the time actually elapsed on its scale, the usual duration ticked when known, never an invented progress bar |
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
`h-10 bg-muted text-xs font-medium text-muted-foreground`, ruled in `border`;
cells `px-3 py-3`, which makes 44 px rows, ruled in `divider`; first column
`pl-4`, last `pr-4`, numbers right-aligned. A divided list rules its rows in
`divider` too (`divide-y divide-divider`), a panel's own frame and header stay
`border`.
`caption` in `sr-only` stating the order and the filter. A row in discrepancy
carries the `SeverityIcon` before the name, with no tinted background.

**A row that leads to a page**: the name is the real link, the one for the
keyboard and for screen readers; the rest of the row follows the click in code,
so an address stays selectable. Cmd, Ctrl and the middle button open a new tab.

**A section with nothing in it stays open** and says why and what to do: the
people with access of a site nobody else has access to say who opens it and
how to add someone, Secrets of a site with no file says to declare `secrets`
in `sitesolide.json` and then run `sitesolide deploy`.

**Buttons.** One primary per view, in petrol. `destructive` is used only for a
confirmation's action. A button in progress says what it is doing:
*Revoking...*, *Saving...*.

**Dialogs.** `Dialog` to type into (anchored at the bottom on a phone), or for
an action that waits a long time for its answer; `AlertDialog` to confirm. A
wait in progress neither closes nor cancels: the server sees it through. A title
naming the object, a description stating the consequence, the primary action on
the right. Focus goes to the first field, then back to the originating element.

**Errors.** Say what did not answer and what to do, without apologising: "Can't
reach the steward." then the command to run. Under the offending field
(`role="alert"`), in a `Banner` when the page stays readable, in an
`ErrorState` when there is nothing to show.

**Search and filters.** In a toolbar under the header, on the left: the search
field, with a `/` key hint, then the filters as a segmented control, a bordered
card whose chosen segment takes the `muted` grey and `strong` text (in dark, the
control sits on `background` so that the grey still shows). `/` focuses the
site search, Escape clears it then returns focus. The count and the order on
the right: "3 of 13 sites, issues first".

**Secrets and passwords.** A field that receives a secret is `type="password"`,
`autoComplete="off"`, `data-1p-ignore`; a textarea, which cannot be, is masked
with `[-webkit-text-security:disc]` plus *Show*. A revealed value lasts thirty
seconds and is masked again on locking, tab hidden, page left, site or section
changed. A write-only file offers neither *Reveal* nor *Copy* and says so; a
password variable offers only *Change password*. A drawn password is shown once,
with its copy button; closing its dialog without having copied it takes two
gestures, the first one warning.

**Keyboard and announcements.** Every focus ring is petrol. A hand-drawn
element takes `focus-visible:ring-2 focus-visible:ring-ring`, solid, 6.0:1 on
`card` in light; a field, generated or hand-drawn, keeps shadcn's
`focus-visible:border-ring` (solid, the same contrast) inside a
`ring-3 ring-ring/50` halo, the halo alone being too pale to count.
After a navigation: scroll to top (except on back), focus on the `h1`, title
announced, tab title updated. One `aria-live` region, through which a password
or a value never passes. Under the sign-in of an expired session, the page is
`inert`.

## 6. Vocabulary

| Object | Word | Do not write |
|---|---|---|
| Machine pages | Sites (the home page), Activity, People, Tokens, Connectors | Dashboard, Home, Overview, Members, Team |
| Connectors | Connector, Add connector, Change, Remove connector, Grant, Withdraw, Granted, Asked, not granted, No such connector, Not asked for, Site removed, Write-only | Integration, Secret, Token, Revoke access |
| Site sections | Overview, Audience, Secrets, Access, Backups; the breadcrumb *All sites > cms*; *Switch site* | Settings, Details, Sharing, Guests, Members |
| The machine | Server | VM, host |
| Discrepancy | Refusal, issues; Error, Warning | Alert, Critical |
| Verdict | All clear, `N errors, N warnings`, Stale data, No data | OK, Healthy |
| Age | Updated 26s ago, just now | Last sync |
| Service | Running, Starting, Restarting, Stopping, Down; Static files, No manifest; Unknown | Up, Offline, Dead |
| General access | General access, Public, Restricted, Anyone with the code, Current; Make public, Restrict; Preview code, Give it a preview code, Replace the code, Remove the code; Open to anyone, guarded by the app alone (the exempt paths) | Door, Gate, Portal on, Portal off, Turn on portal, Private, Password protected, Enable, Disable |
| People with access | People with access, Add people, Add, Unlock to add, Remove; Owner, Can open, Viewer, Developer, Admin; company account, password access, Password access lasts, No expiry, expires in 5d, Added by; Copy message; What each role can do, Your role | Sharing, Share, Guest, Member, Team, Invite, Permissions, ACL, work account, Super admin, Project admin |
| People | People, May create projects, Let someone create projects, Allow, Unlock to allow, Remove from every project, Domains | Members, Invite |
| Tokens | Tokens, New token, Unlock to create, Create token, Revoke, Revoke token, Active, Expired, Revoked, Their own, Copy message, Recent deployments | Team, API key |
| Secrets | Locked, Unlocked, Unlock, Lock, Restart pending, Unmanaged, Missing, Write-only, Restart service, Restore previous, Add variable, Create file, Replace, Reveal | Vault, Decrypt, Edit file |
| Passwords | Change password, Dashboard password, Generate a strong one, Set my own, New password, Copy password | Set hash, Regenerate |
| Backups | Snapshot, Scheduled, Before restore, Server, Offsite only, Restore, Restoring..., Restored, Offsite copy, Show all | Backup file, Revert, Rollback, Recover |
| Activity | Event, Actor, Action, Target, Source, Site or host, From, To, Details, Load older, Export, CSV, JSON lines, Clear filters; a source is Read, Latest 50, Can't read, Needs updating, Not installed | Log entry, Audit trail, Download, Reset |
| Unreachable | Can't reach the dashboard., Can't reach the steward. | is not answering |
| Common actions | Refresh, Retry, Sign in, Sign out, Copy, Copied, Cancel, Close, Done, Manage | Reload, Try again, Log out, Submit |
| Empty states | No issues, No sites match "x", No site is restricted, Nobody else has access to cms yet, Nobody has access to a project yet, cms has no secret files, Not part of your role, Only the owner's | Nothing here! |

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
panel, errors first, then the search, the
filters (All, Issues, Apps, Static, Restricted, each with its count) and the
inventory, sites in discrepancy at the top: Site, Address, Access, Service,
Size. The Access column gives the general access in a word, *Restricted*,
*Public*, or for *Anyone with the code* the code itself with its copy and
open buttons; a disagreement with `sitesolide.json` in red. Summaries live
in the rows, not in cards.

**Activity.** The machine's audit, every component's in one log, newest first,
read with the session alone since no row holds a value. *Export* in the header,
CSV or JSON lines of the rows read, once something has been read. Then the
sources once, each with its state in a word (*Read*, *Latest 50*, *Can't
read*, *Needs updating*, *Not installed*), and a banner for each source that
could not be read, saying what to do. Then the filters: the source as chips
like the home page's, then *Actor*, *Action*, *Site or host*, *From* and *To*;
typed fields apply once typing pauses, the count on the right. The log: Actor,
Action (what happened in words, its tone when it went wrong, the dotted action
and a note below), Target (the site linked, the host below), Source, When,
and *Details*, which opens every field and the detail as key and value, text
only. *Load older* at the foot while a source has more; a page that finds
nothing goes on by itself a few times before handing the choice back. Under
the panel, which sources only hand over their latest entries.

**People.** The owner's alone. The lock in the header, the same as the
secrets'; one sentence under it: roles are given and changed in each
project's Access section, here someone is let create projects or removed
from every project at once. A banner when company sign-in is not set up,
since everyone added then gets password access. The **People** panel,
everyone with access to a project, by email: their role on each project in
words, each project linked to its Access section (`blog: Developer, shop:
Password access, expires in 5d`, an expiry within a day in attention), and
the admin emails marked as opening every restricted site; a *May create
projects* checkbox, a column of its own in a wide panel, offered only to
someone with a company account and the reason otherwise; *Remove*, which
takes them off every project in a destructive confirmation: they lose every
role and password access at their next request, may no longer create
projects, are signed out, and their tokens are revoked. Under the list, *Let
someone create projects*: a company email, *Allow* once unlocked, *Unlock to
allow* before. Giving the right waits for the unlock, taking it away does
not. Then **Domains**: each domain with access, and the sites it opens,
linked to their Access.

**Tokens.** The lock in the header, the same as the secrets'. One sentence on
what a token does, the owner's or a person's. The **Tokens** panel, its count
the live ones: each token's label, its holder's email in the owner's list,
its state (*Active*, *Expires in 5d* in attention, *Expired*, *Revoked*),
*Their own* on a person's own token in the owner's list, its scope in words,
the projects it reaches, those it created marked, when it was created, last
used and until when, and *Revoke*, which needs no unlock. *New token* once
unlocked, *Unlock to create* before. Then **Recent deployments** and
**Activity**, side by side in a wide body. The owner sees every token; a
person sees their own alone, and mints them under their own unlock, never
beyond their roles. The dialog takes a label, an email for the owner's, an
expiry, the projects it may deploy, and its permissions, each saying what
it allows and what it costs: *Create projects*, *Deploy public sites*, *Use
outbound network*, *Declare a domain*; a person sees only the projects where
they are a Developer or an Admin, creating projects only with the right, the
other three only for projects they administer. The token is then shown once,
with *Copy message*.

**The sign-in page, with a provider.** Above the password, *Sign in with
<provider>*, an outline link to `/api/sso/begin` and not a form, the flow
leaving for the portal's host; then a rule with *or with the owner's
password* in its middle. A sign-in that came back without a session says why
above both, in `destructive`: no role on any project here, a domain not
allowed, expired, not available.

**Connectors.** The lock in the header, the same as the secrets'. Then three
panels. **Connectors**: each one's name, base address, header, how many
projects have it and when it changed, *Write-only* since its value is never
shown; *Add connector*, *Change* and *Remove* once unlocked. **Grants**: every
pair of a site and a connector that matters, what needs a decision first (a
grant whose site is gone in error, a request not granted in attention), with
*Grant* or *Withdraw*. **Egress activity**: the proxy's refusals, connector
calls and changes, read from the proxy itself. The add and change dialog types
the value in a password field and leaves it empty on a change to keep it; a
removal retypes the name.

**A site's Overview.** Under the title, the state in one sentence, the
description and the main address; its discrepancies as banners. Then two
columns: on the left the site on the machine, **Service**, **Addresses**,
**Storage**; on the right what opens it and what it keeps, **General
access** and **Secrets**, each with *Manage* to its section. **General
access** names how the site opens and what that does to a visitor, the code
for *Anyone with the code*, the exempt paths for *Restricted*, and, when it
disagrees, `sitesolide.json` and the server side by side. Every role sees it,
with its *Manage*; **Secrets** shows from Developer up. A Developer or an
Admin finds *Restart* in **Service**'s header, which confirms, waits for the
steward's verdict and says it in plain words, or shows the steward's refusal
as it stands.

**A site's Secrets.** The lock in the header: locked, a single *Unlock* button with a key, no state pill beside it; unlocked, a warning pill with the time left and a *Lock* button. The **Files** panel: the service
and *Restart service*, what is wrong, then each file. A variables file lists its
variables; a password variable offers only *Change password*. A file read whole
states its size and offers *Replace*, and *Reveal* if it is readable. Then
**Activity**, that site's operations. Restarting the dashboard itself gives the
*Restarting* verdict: the dialog waits out the cut, reconnects by itself, then
asks you to unlock again.

**A site's Access.** Who can open the site, and what each person can do with
it, in one place, laid out like a "Share" dialog. Under the title, one
sentence saying so. For the owner and the project's Admins, the lock in the
header, once the secrets are read: the unlock that giving a role above Can
open, or password access, waits for. Banners: the last change of general
access, which the repository has yet to follow (`sitesolide deploy` in the
project's folder, with *Copy*); the portal on the server still reading its
own lists, or unable to read who has access (`sitesolide upgrade`); for the
owner, company sign-in not set up, so that everyone added gets password
access, with where to set it, the portal's `portal.env`. Then two columns in
a wide body.

On the left, **General access** first: Public, Restricted and Anyone with
the code, one sentence each, the current one marked as the sidebar marks the
current page, *Current* beside its name; a disagreement between
`sitesolide.json` and the server above them, in red; under Restricted, the
paths open to anyone, guarded by the app alone; under Anyone with the code,
the code and its link, to copy or open. For the owner and the project's
Admins each other way says what choosing it does: *Make public* or
*Restrict* when the steward accepts, its reason otherwise, said once under
the choices; `sitesolide lock`, from the project's folder, to give a code;
while one is set, `sitesolide lock --new-code` and `sitesolide unlock`, the
dashboard only showing the code. The confirmation states the gatekeeper's
three steps and the rollback on failure; making a site public warns that
anyone with its address then opens it, and makes you retype the slug; the
wait neither closes nor cancels and shows the time elapsed on a minute and a
half's scale; the result ends on the repository reminder.

Then **People with access**, its count in the title, and while the site is
not restricted a note that Can open changes nothing until it is. *Add
people* at the top: an email or a `@domain`, the domain only once company
sign-in is set up, a role among those the viewer may give, and for password
access how long it lasts, 24 hours, 7 days, 30 days or no expiry. The line
under the field says, before anything is sent, what adding gives: someone
who signs in with their company account, everyone with an account at a
domain, or password access, to open the site only, its end, and that the
password is shown once; or why it cannot be given, and why higher roles are
not offered. *Unlock to add* stands for *Add* when the role or the password
waits for the unlock. After adding, the line to send, with *Copy*, since no
email is sent; for password access, a dialog with the address, the password
and its end, and *Copy message*. Then one list: the Owner's row, then
every entry, higher roles first, then people, domains and password access,
each with who, *(you)* on one's own row, what it is (everyone at a domain,
password access and its expiry, an email that is not a company account), who
added it and when, quietly; its role in a menu when the viewer may change
it, as a word otherwise; and *Remove*, which confirms. Last, the admin emails
of `OIDC_ADMIN_EMAILS`, as opening every restricted site. A Viewer or a
Developer finds in its place an empty state: only the project's Admins see
this list, their own role said in words, and whom to ask.

On the right, **What each role can do**, from Can open to Owner, the
viewer's own marked *Your role*.

**A site's Backups.** The lock in the header, a restore asking for the dashboard
password like a secret. **Schedule**: how fresh the last snapshot is (the last
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
2. **A red brand**: the logo was a red seal, and beside a petrol accent the
   two clashed; in a tool where red means error, it also said error at the top
   of every page. The logo moved into the accent's family, and red kept one
   meaning.
3. **A summary in three side-by-side cards**: what it said lives in the sites'
   rows.
4. **Every identifier in monospace**: it is kept for what is typed in a
   terminal.
5. **Inter**, shadcn's font, then **widened Archivo** for titles, the landing
   page's: one family, Geist, holds a dense page better, and Geist Mono gives
   what is typed in a terminal a matching voice.
6. **Tinted backgrounds on rows in discrepancy**: the icon already says it.
7. **Screen breakpoints**: the sidebar made any `lg:` rule wrong by one sidebar
   width (3.2).
8. **Machine-wide Secrets and password access pages**: everything about a
   site lives in that site.
9. **A ticked step bar while waiting for the gatekeeper**: the page does not
   know where it is, so it shows the steps and the elapsed time, ticking
   nothing.
10. **The plate dark in both themes**, the landing page's deep section carried
    into the page: in light it was the one dark object on the screen. A
    bordered panel that follows the theme reads as one with the rest, and its
    ticks keep it remarkable.
11. **An ink primary, midnight blue on cold glass**: petrol gives "here" a
    single colour, from the primary button to the focus ring and the
    sidebar's marker, and stays clear of the error red and of the three tones.
12. **Four sections for one question**: who opens a site, who signs in to it
    with a password, who signs in with their company account and who does
    what on it in the dashboard lived in four sections of a site, and two
    more pages at the machine level, each answering part of it in its own
    words. One *Access* section per site, read like a "Share" dialog, *People*
    across projects and *Tokens* answer it once each, in the words of one
    ladder of roles.

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
`calendar` and a Viewer on `photos`, and a few others. Variants:
`BENCH_PORT`, `BENCH_STALE=1`, `BENCH_NO_STEWARD=1`, `BENCH_NO_PORTAL=1`,
`BENCH_NO_SSO=1` (no provider: everyone added gets password access),
`BENCH_NO_EGRESS=1`, `BENCH_NO_BACKUPS=1`, `BENCH_OLD_STEWARD=1`,
`BENCH_EMPTY=1`, `BENCH_SHOWCASE=1`. After `bun run web:build`, a reload is
enough.

A visible change is looked at before being shipped, through headless Chrome
screenshots of the bench, in light and in dark:

- the home page, Activity, People and Tokens; the five sections of a site,
  the Overview of a service in a restart loop and of a locked static site,
  the Secrets of a site with a write-only file and a subdirectory, and of the
  dashboard itself;
- at 1440 px, at 1024 px with the sidebar expanded, and at 390 px;
- the collapsed sidebar, the switcher open, sign-in, an expired session, Secrets
  unlocked, the new token dialog;
- Access as the owner, as an Admin and as a Viewer; *Add people* with a
  company account, a domain and someone who gets password access, locked and
  unlocked; the password dialog; making a site public, its confirmation, the
  wait and the success, the restored failure; a site that opens with a code;
- a person's shell, signed in through the bench's provider page, as a
  Viewer, a Developer and an Admin;
- the outages, on a second bench with `BENCH_NO_STEWARD=1
  BENCH_NO_PORTAL=1`, and company sign-in not set up with `BENCH_NO_SSO=1`.

Compare them from page to page: same header, same content width, same panel
titles, same words for the same states.
