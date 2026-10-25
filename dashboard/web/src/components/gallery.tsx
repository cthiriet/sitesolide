import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ArchiveRestore, ArrowUpRight, Copy, KeySquare, Plus, RotateCcw, Trash2 } from "lucide-react"
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Announcements, useAnnounce } from "@/components/copy"
import { DataProvider } from "@/components/data"
import { CellText, DataTable, RowButton, RowMenu, RowMenuLink, SeverityGutter, type Column } from "@/components/data-table"
import { DetailSheet, SheetFacts, SheetSection, useSheet } from "@/components/detail-sheet"
import { FilterBar, useListState, type Facet, type SortOption } from "@/components/filter-bar"
import { AccessIcon, KindIcon, LegendEntry, accessEntry, kindEntry } from "@/components/legend"
import { Router, useNavigation } from "@/components/navigation"
import { Banner, Count, EmptyState, InlineEmpty, PageBody, PageHeader, Panel, StateLabel, Status, When } from "@/components/page"
import { SecretsActionsProvider } from "@/components/secrets-actions"
import { PendingShell } from "@/components/shell"
import { AppSidebar, MobileTabs } from "@/components/sidebar"
import { useTheme } from "@/components/theme"
import { LockGlyph, WriteButton, WriteMenuItem } from "@/components/unlock"
import { ACCESS_KEYS, KINDS, accessKey, type Kind } from "@/lib/legend"
import { narrowList, type ListSpec } from "@/lib/list-state"
import { SIDEBAR_WIDTH } from "@/lib/sidebar"
import type { Access } from "@/lib/sites"
import type { Tone } from "@/lib/tones"
import type { Severity } from "@/lib/verdict"

/**
 * The pattern gallery, `/gallery/` on a bench built with DASHBOARD_GALLERY=1:
 * every shared pattern drawn by the real components, in the real shell,
 * signed in against the bench. Its rows are fictitious and fixed, so that
 * each pattern shows its every case; the unlock, the sheet's Recent and the
 * History links are the bench's own. Switch the theme from the sidebar or
 * the header, and narrow the window, to see the rest.
 */

// --- The fictitious rows ---------------------------------------------------------------

const HOUR = 3_600_000

type Specimen = {
  slug: string
  kind: Kind
  access: Access
  address: string
  deployedAgo: number
  severity: Severity | null
  state: { tone: Tone; label: string; more: number; title?: string } | null
  platform?: boolean
}

const SPECIMENS: readonly Specimen[] = [
  {
    slug: "roster",
    kind: "app",
    access: { kind: "mismatch", key: "portal-absent", label: "Restricted in sitesolide.json, public on the server" },
    address: "roster.example.com",
    deployedAgo: 0.4 * HOUR,
    severity: "error",
    state: { tone: "error", label: "Restarting", more: 2, title: "Restarting: the service exits after 2 s. Access mismatch. Port not listening." },
  },
  {
    slug: "courier",
    kind: "background",
    access: { kind: "portal", exemptions: [] },
    address: "No page",
    deployedAgo: 5 * HOUR,
    severity: "warning",
    state: { tone: "attention", label: "Last run failed", more: 0 },
  },
  {
    slug: "calendar",
    kind: "app",
    access: { kind: "portal", exemptions: ["/api/webhooks/*"] },
    address: "calendar.example.com",
    deployedAgo: 20 * HOUR,
    severity: "warning",
    state: { tone: "attention", label: "Restart pending", more: 0 },
  },
  { slug: "cms", kind: "app", access: { kind: "portal", exemptions: [] }, address: "cms.example.com", deployedAgo: 20 * HOUR, severity: null, state: null },
  { slug: "bookshop", kind: "static", access: { kind: "open" }, address: "bookshop.example.com", deployedAgo: 3 * 24 * HOUR, severity: null, state: null },
  {
    slug: "wheels",
    kind: "static",
    access: { kind: "code", code: "K7Q2-W9DM", url: "https://wheels.example.com/?code=K7Q2-W9DM" },
    address: "wheels.example.com",
    deployedAgo: 26 * HOUR,
    severity: null,
    state: null,
  },
  { slug: "reports", kind: "scheduled", access: { kind: "open" }, address: "No page", deployedAgo: 9 * 24 * HOUR, severity: null, state: null },
  { slug: "photos", kind: "app", access: { kind: "portal", exemptions: [] }, address: "photos.example.com", deployedAgo: 12 * 24 * HOUR, severity: null, state: null },
  { slug: "library", kind: "app", access: { kind: "open" }, address: "library.example.com", deployedAgo: 30 * 24 * HOUR, severity: null, state: { tone: "neutral", label: "Unknown", more: 0 } },
  { slug: "yoga-studio", kind: "static", access: { kind: "open" }, address: "yogastudio.example", deployedAgo: 2 * 24 * HOUR, severity: null, state: null },
  { slug: "lab", kind: "app", access: { kind: "open" }, address: "lab.example.com", deployedAgo: 6 * 24 * HOUR, severity: null, state: null },
  { slug: "legacy", kind: "none", access: { kind: "open" }, address: "legacy.example.com", deployedAgo: 200 * 24 * HOUR, severity: null, state: null },
]

const SPEC: ListSpec = {
  facets: { access: ACCESS_KEYS, kind: KINDS },
  sorts: ["issues", "name", "deployed"],
}

const SORTS: readonly SortOption[] = [
  { value: "issues", label: "Issues first" },
  { value: "name", label: "Name" },
  { value: "deployed", label: "Last deployed" },
]

const RANK: Readonly<Record<string, number>> = { error: 0, warning: 1 }

function sortSpecimens(rows: readonly Specimen[], sort: string | null): Specimen[] {
  const byName = (a: Specimen, b: Specimen) => a.slug.localeCompare(b.slug, "en")
  if (sort === "name") return [...rows].sort(byName)
  if (sort === "deployed") return [...rows].sort((a, b) => a.deployedAgo - b.deployedAgo)
  return [...rows].sort((a, b) => (RANK[a.severity ?? ""] ?? 2) - (RANK[b.severity ?? ""] ?? 2) || byName(a, b))
}

// --- The pieces ------------------------------------------------------------------------

/** A section of the gallery: the pattern's name, its file, a sentence, then the pattern itself. */
function Specimen({ name, file, children, note }: { name: string; file: string; note: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={name} className="grid gap-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-heading">{name}</h2>
          <code className="font-mono text-xs text-muted-foreground">{file}</code>
        </div>
        <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  )
}

/** What a gallery write does once performed: says so, since nothing here is real. */
function usePerformed() {
  const announce = useAnnounce()
  const [last, setLast] = useState<string | null>(null)
  return {
    last,
    perform: (what: string) => {
      setLast(what)
      announce(`${what}: performed. Nothing changed, this is the gallery.`)
    },
  }
}

function SiteMenu({ row, onRestart }: { row: Specimen; onRestart: () => void }) {
  return (
    <RowMenu label={`Actions for ${row.slug}`}>
      <DropdownMenuGroup>
        <RowMenuLink href={`https://${row.address}`} external>
          <ArrowUpRight />
          Open site
        </RowMenuLink>
        <DropdownMenuItem className="h-9" onClick={() => void navigator.clipboard?.writeText(row.address)}>
          <Copy />
          Copy address
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <WriteMenuItem onPress={onRestart} purpose={`restart ${row.slug}`}>
        <RotateCcw />
        Restart
      </WriteMenuItem>
      <DropdownMenuSeparator />
      <WriteMenuItem variant="destructive" onPress={onRestart} purpose={`remove ${row.slug}`}>
        <Trash2 />
        Remove site
      </WriteMenuItem>
    </RowMenu>
  )
}

function columns(open: (slug: string) => void): Column<Specimen>[] {
  return [
    {
      key: "site",
      head: "Site",
      width: "minmax(220px,1.3fr)",
      slot: "primary",
      cell: (row) => (
        <>
          <KindIcon kind={row.kind} />
          <RowButton onClick={() => open(row.slug)}>{row.slug}</RowButton>
          {row.state !== null && (
            <StateLabel tone={row.state.tone} more={row.state.more} title={row.state.title}>
              {row.state.label}
            </StateLabel>
          )}
        </>
      ),
    },
    {
      key: "address",
      head: "Address",
      width: "minmax(180px,1fr)",
      slot: "meta",
      cell: (row) => (
        <CellText title={row.address} className="font-mono text-[0.8125rem] text-muted-foreground max-md:text-xs">
          {row.address}
        </CellText>
      ),
    },
    {
      key: "access",
      head: "Access",
      width: "76px",
      align: "center",
      slot: "state",
      cell: (row) => <AccessIcon access={row.access} slug={row.slug} />,
    },
    {
      key: "deployed",
      head: "Deployed",
      width: "96px",
      align: "end",
      slot: "time",
      cell: (row) => <When at={NOW - row.deployedAgo} serverNow={NOW} />,
    },
  ]
}

/** The rows' clock: fixed, so that the ages read the same on every capture. */
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)

// --- The page --------------------------------------------------------------------------

function GalleryPage() {
  const { toggle, label: themeLabel, Icon: ThemeIcon } = useTheme()
  const list = useListState(SPEC)
  const sheet = useSheet("site")
  const { last, perform } = usePerformed()

  const { rows, counts } = useMemo(
    () =>
      narrowList(SPECIMENS, list, {
        search: (row, query) => row.slug.includes(query.trim().toLowerCase()) || row.address.includes(query.trim().toLowerCase()),
        facets: { access: (row) => accessKey(row.access), kind: (row) => row.kind },
      }),
    [list],
  )
  const sorted = sortSpecimens(rows, list.sort)
  const facets: Facet[] = [
    {
      name: "access",
      label: "Access",
      options: ACCESS_KEYS.filter((key) => key !== "mismatch" || (counts.access?.mismatch ?? 0) > 0).map((key) => {
        const entry = accessEntry(key)
        return { value: key, label: entry.facet, icon: entry.icon, tone: entry.tone, count: counts.access?.[key] ?? 0 }
      }),
    },
    {
      name: "kind",
      label: "Kind",
      options: KINDS.map((kind) => {
        const entry = kindEntry(kind)
        return { value: kind, label: entry.facet, icon: entry.icon, count: counts.kind?.[kind] ?? 0 }
      }),
    },
  ]
  const open = sheet.id === null ? null : (SPECIMENS.find((row) => row.slug === sheet.id) ?? null)
  const columnsFor = columns(sheet.open)

  return (
    <>
      <PageHeader
        title="Patterns"
        count={SPECIMENS.length}
        intro={
          <>
            <p>
              Every shared pattern of the dashboard, drawn by the real components with fictitious rows. A screen is built from
              these and nothing else.
            </p>
            <p className="text-muted-foreground">web/DESIGN.md, sections 1, 3.3 and 5, says when to use which.</p>
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={toggle} className="text-muted-foreground hover:text-foreground max-md:size-10 max-md:px-0">
              <ThemeIcon />
              <span className="max-md:sr-only">{themeLabel}</span>
            </Button>
            <WriteButton onPress={() => perform("New token")} purpose="create a token" resume="New token" className="max-md:h-10">
              <Plus />
              New token
            </WriteButton>
          </>
        }
        history={{ type: "tokens" }}
      />
      <PageBody className="gap-10">
        {last !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            Last write performed: <span className="font-medium text-foreground">{last}</span>. Nothing changed, this is the gallery.
          </p>
        )}

        <Specimen
          name="PageHeader"
          file="components/page.tsx"
          note={
            <>
              Above: the title, its count, the (i) holding the page's intro, the page's one primary action, History (Activity
              narrowed, lib/history.ts), the unlocked pill once unlocked, the verdict, the age, refresh. Press New token while
              locked: the unlock comes first, then the action.
            </>
          }
        />

        <Specimen
          name="FilterBar and DataTable"
          file="components/filter-bar.tsx, components/data-table.tsx"
          note={
            <>
              The search with its "/" key, a facet per dimension with the rows' own icons and live counts, "3 of 12" while
              narrowed, the sort; the address holds it all. Rows of 44 px, the severity gutter, the kind icon, the name as the
              sheet's button, a state word only when not fine, machine strings in muted mono, an age right-aligned, the row
              menu. The head sticks under the page header.
            </>
          }
        >
          <FilterBar list={list} facets={facets} sorts={SORTS} shown={rows.length} total={SPECIMENS.length} noun={{ one: "site", many: "sites" }} search={{ label: "Search sites" }} />
          <Panel full>
            <DataTable
              label="Sites"
              caption="Fictitious sites, issues first"
              rows={sorted}
              rowKey={(row) => row.slug}
              columns={columnsFor}
              severity={(row) => row.severity}
              onRowClick={(row) => sheet.open(row.slug)}
              menu={(row) => <SiteMenu row={row} onRestart={() => perform(`Restart ${row.slug}`)} />}
              selected={sheet.id}
              empty={
                <InlineEmpty icon={KeySquare} action={<Button variant="link" className="h-auto p-0" onClick={list.clear}>Clear filters</Button>}>
                  No sites match.
                </InlineEmpty>
              }
            />
          </Panel>
        </Specimen>

        <Specimen
          name="Two lines, below the width the columns need"
          file="DataTable narrowBelow"
          note="The same table in a container 360 px wide, as on a phone: the name and the state on the first line, the meta and the time on the second, the menu at its end. The table's own width decides, never the screen's."
        >
          <div className="max-w-[22.5rem]">
            <Panel full>
              <DataTable
                label="Sites, narrow"
                rows={sortSpecimens(SPECIMENS, "issues").slice(0, 5)}
                rowKey={(row) => row.slug}
                columns={columnsFor}
                severity={(row) => row.severity}
                onRowClick={(row) => sheet.open(row.slug)}
                menu={(row) => <SiteMenu row={row} onRestart={() => perform(`Restart ${row.slug}`)} />}
              />
            </Panel>
          </div>
        </Specimen>

        <Specimen
          name="Dense rows, the row's one action"
          file="DataTable dense"
          note="40 px rows for Activity and Backups. The one action the page exists for may sit in the row, here Restore, carrying the lock glyph while locked; the rest stays in the menu."
        >
          <Panel full>
            <DataTable
              label="Snapshots"
              dense
              narrowBelow="36rem"
              rows={[0, 1, 2, 3]}
              rowKey={(index) => String(index)}
              columns={[
                { key: "taken", head: "Taken", width: "minmax(160px,1fr)", slot: "primary", cell: (index) => <span className="font-medium">Today {19 - index}:02</span> },
                { key: "size", head: "Size", width: "96px", align: "end", slot: "time", cell: (index) => <span className="tabular-nums">{(3.1 - index * 0.1).toFixed(1)} MB</span> },
                {
                  key: "restore",
                  head: "",
                  srHead: "Restore",
                  width: "120px",
                  align: "end",
                  slot: "state",
                  cell: (index) => (
                    <WriteButton variant="outline" size="sm" onPress={() => perform(`Restore snapshot ${index + 1}`)} purpose="restore cms" resume="Restore">
                      <ArchiveRestore />
                      Restore
                    </WriteButton>
                  ),
                },
              ]}
              foot={
                <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:text-foreground">
                  Show all 37
                </Button>
              }
            />
          </Panel>
        </Specimen>

        <Specimen
          name="Quiet when fine"
          file="StateLabel, SeverityGutter, Status in components/page.tsx"
          note="A fine row says nothing: no Running, no green dot. A row in trouble carries the severity icon in its gutter and a short word in its tone; neutral information stays muted. The page's verdict says All clear once."
        >
          <Panel full>
            <ul className="divide-y divide-divider">
              {(
                [
                  ["ok", "Running", null],
                  ["neutral", "Not declared", null],
                  ["attention", "Restart pending", "warning"],
                  ["error", "Port not listening", "error"],
                ] as const
              ).map(([tone, word, severity]) => (
                <li key={tone} className="flex h-11 items-center gap-3 px-4">
                  <SeverityGutter severity={severity} />
                  <span className="w-24 font-mono text-xs text-muted-foreground">{tone}</span>
                  <span className="font-medium text-strong">cms</span>
                  <StateLabel tone={tone}>{word}</StateLabel>
                  {tone === "ok" && <span className="text-xs text-faint">(nothing shown)</span>}
                </li>
              ))}
              <li className="flex h-11 items-center gap-3 px-4">
                <span className="w-7" />
                <span className="w-24 font-mono text-xs text-muted-foreground">verdict</span>
                <Status tone="ok" shape="pill">
                  All clear
                </Status>
                <Status tone="error" shape="pill">
                  1 error, 2 warnings
                </Status>
              </li>
            </ul>
          </Panel>
        </Specimen>

        <Specimen
          name="KindIcon and AccessIcon"
          file="components/legend.tsx, lib/legend.ts"
          note="One meaning everywhere, 16 px, muted unless they carry a state; the tooltip says it in the Access section's words. The facet menus show the same icons, so they are the legend."
        >
          <div className="grid gap-4 @3xl/body:grid-cols-2">
            <Panel title="Kind" full>
              <ul className="divide-y divide-divider">
                {KINDS.map((kind) => {
                  const entry = kindEntry(kind)
                  return (
                    <li key={kind} className="flex h-11 items-center gap-3 px-4">
                      <KindIcon kind={kind} />
                      <span className="min-w-0 flex-1">{entry.label}</span>
                      <code className="font-mono text-xs text-muted-foreground">{entry.icon.displayName ?? kind}</code>
                    </li>
                  )
                })}
              </ul>
            </Panel>
            <Panel title="Access" full>
              <ul className="divide-y divide-divider">
                {SPECIMENS.filter((row, index, all) => all.findIndex((other) => accessKey(other.access) === accessKey(row.access)) === index).map((row) => {
                  const entry = accessEntry(accessKey(row.access))
                  return (
                    <li key={row.slug} className="flex h-11 items-center gap-3 px-4">
                      <AccessIcon access={row.access} slug={row.slug} />
                      <span className="min-w-0 flex-1">
                        <LegendEntry icon={entry.icon} tone={entry.tone}>
                          {entry.label}
                        </LegendEntry>
                      </span>
                      <span className="text-xs text-muted-foreground">hover the first icon</span>
                    </li>
                  )
                })}
              </ul>
            </Panel>
          </div>
        </Specimen>

        <Specimen
          name="Just-in-time unlock"
          file="components/unlock.tsx"
          note={
            <>
              No Unlock button anywhere. A write says what it does and carries the lock glyph <LockGlyph /> while locked;
              pressed, it asks for the password (a person signs in again), then performs. useWrite() for a form or a
              checkbox; WriteMenuItem in a row menu; unlock={"{false}"} for what needs none, Restrict and Revoke.
            </>
          }
        >
          <Panel>
            <div className="flex flex-wrap items-center gap-2">
              <WriteButton onPress={() => perform("Add")} purpose="add someone" resume="Add">
                Add
              </WriteButton>
              <WriteButton variant="outline" onPress={() => perform("Make public")} purpose="make cms public">
                Make public
              </WriteButton>
              <WriteButton variant="outline" unlock={false} onPress={() => perform("Restrict")}>
                Restrict
              </WriteButton>
              <WriteButton variant="ghost" size="sm" onPress={() => perform("Generate")} purpose="generate a value">
                Generate
              </WriteButton>
              <RowMenu label="A row menu with writes">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>cms</DropdownMenuLabel>
                  <WriteMenuItem onPress={() => perform("Replace value")}>Replace value</WriteMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <WriteMenuItem variant="destructive" unlock={false} onPress={() => perform("Revoke token")}>
                  Revoke token
                </WriteMenuItem>
              </RowMenu>
            </div>
          </Panel>
        </Specimen>

        <Specimen
          name="InlineEmpty, and the tiled EmptyState"
          file="components/page.tsx"
          note="Inside a panel, empty is one 44 px line: an icon, the state, one action. A section with nothing and nothing to ask disappears. The tile stays for a page with nothing at all."
        >
          <div className="grid gap-4 @3xl/body:grid-cols-2">
            <Panel full>
              <InlineEmpty
                icon={KeySquare}
                action={
                  <WriteButton variant="link" className="h-auto p-0" onPress={() => perform("New token")} purpose="create a token">
                    New token
                  </WriteButton>
                }
              >
                No token yet.
              </InlineEmpty>
            </Panel>
            <Panel>
              <EmptyState icon={KeySquare} title="No sites deployed yet" compact>
                A site appears here after its first sitesolide deploy.
              </EmptyState>
            </Panel>
          </div>
        </Specimen>

        <Specimen
          name="Banner"
          file="components/page.tsx"
          note="What has no row of its own, a server issue or an orphan, sits above the toolbar as a banner of one line; at most two, then Show N more."
        >
          <div className="grid gap-2">
            <Banner tone="error" action={<Button variant="outline" size="sm">Show</Button>}>
              <span className="font-medium">Server:</span> the last backup run failed for photos.
            </Banner>
            <Banner tone="attention">
              <span className="font-medium">old-kiosk:</span> a live Caddy fragment with no folder.
            </Banner>
          </div>
        </Specimen>

        <p className="text-xs text-muted-foreground">
          <Count>{SPECIMENS.length}</Count> fictitious rows; the sheet's Recent and every History link read the bench's own Activity.
        </p>
      </PageBody>

      <DetailSheet
        open={open !== null}
        onClose={sheet.close}
        title={open?.slug ?? ""}
        state={
          open?.state != null ? (
            <StateLabel tone={open.state.tone} more={open.state.more} title={open.state.title}>
              {open.state.label}
            </StateLabel>
          ) : undefined
        }
        description={open === null ? undefined : <span className="font-mono text-[0.8125rem]">{open.address}</span>}
        actions={
          open === null ? undefined : (
            <>
              <WriteButton variant="outline" size="sm" onPress={() => perform(`Restart ${open.slug}`)} purpose={`restart ${open.slug}`}>
                <RotateCcw />
                Restart
              </WriteButton>
              <SiteMenu row={open} onRestart={() => perform(`Restart ${open.slug}`)} />
            </>
          )
        }
        history={open === null ? undefined : { target: open.slug }}
      >
        {open !== null && (
          <SheetSection title="Details">
            <SheetFacts
              facts={[
                {
                  label: "Kind",
                  value: (
                    <LegendEntry icon={kindEntry(open.kind).icon}>{kindEntry(open.kind).label}</LegendEntry>
                  ),
                },
                {
                  label: "Access",
                  value: (
                    <LegendEntry icon={accessEntry(accessKey(open.access)).icon} tone={accessEntry(accessKey(open.access)).tone}>
                      {accessEntry(accessKey(open.access)).label}
                    </LegendEntry>
                  ),
                },
                { label: "Address", value: <span className="font-mono text-[0.8125rem]">{open.address}</span> },
                { label: "Deployed", value: <When at={NOW - open.deployedAgo} serverNow={NOW} /> },
              ]}
            />
          </SheetSection>
        )}
      </DetailSheet>
    </>
  )
}

/**
 * The gallery's shell, the dashboard's own: the sidebar, the page, the tabs.
 * A link to another page leaves the gallery for the real one.
 */
function GalleryShell() {
  const { path } = useNavigation()
  useEffect(() => {
    if (path !== "/gallery/") window.location.assign(window.location.href)
  }, [path])
  return (
    <SidebarProvider style={{ "--sidebar-width": SIDEBAR_WIDTH } as CSSProperties}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <SecretsActionsProvider>
          <GalleryPage />
        </SecretsActionsProvider>
      </SidebarInset>
      <MobileTabs />
    </SidebarProvider>
  )
}

/** The gallery's island: the application's providers, signed in like any page. */
export function GalleryApplication() {
  return (
    <Announcements>
      <Router path="/gallery/">
        <TooltipProvider delay={300}>
          <DataProvider wait={<PendingShell path="/gallery/" />}>
            <GalleryShell />
          </DataProvider>
        </TooltipProvider>
      </Router>
    </Announcements>
  )
}
