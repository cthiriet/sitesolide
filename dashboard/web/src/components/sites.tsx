import type { ReactNode } from "react"
import { ArrowUpRight, Copy, Link2 } from "lucide-react"
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CHIP, RoleBars } from "@/components/access-word"
import { useCopy } from "@/components/copy"
import { useData } from "@/components/data"
import { CellText, DataTable, RowLink, RowMenu, RowMenuLink, type Column } from "@/components/data-table"
import { MemoryUsage } from "@/components/gauge"
import { AccessIcon, KindIcon } from "@/components/legend"
import { StateLabel, When } from "@/components/page"
import { SECTION_ICONS } from "@/components/sidebar"
import { roleLabel } from "@/lib/access"
import { ABSENT, size } from "@/lib/format"
import { roleOn } from "@/lib/identity"
import { siteKind } from "@/lib/legend"
import { sectionsFor, siteUrl } from "@/lib/pages"
import { siteFolder } from "@/lib/site-card"
import { PLATFORM_FACET, busyShare, figure, kindDetail, listedAccess, memoryUsage, type ListedSite, type RowState } from "@/lib/site-list"
import { HEADLESS_NOTE, computeCpuShare, memoryReading, processorShare, processorTitle, siteAccess, siteAddress, siteWeight } from "@/lib/sites"
import { cn } from "@/lib/utils"

/**
 * The Sites list: one line per site, 44 px, quiet when fine.
 *
 *   | gutter | [kind] slug  tags  State +N | address | access | memory | deployed | ... |
 *
 * A healthy row says its kind, its name, its address, how it opens, what its
 * services hold against their limit and when it was deployed, nothing more;
 * a site taking a large share of the processor says so beside its name, "CPU
 * 18%". A row in trouble carries the severity icon in the gutter and its
 * first issue's word beside the name, every message in the word's tooltip.
 * CPU and disk come back as a column when the list is sorted by them. Below
 * 42 rem of its own width, 48 rem with that column, two lines: the name and
 * the access, then the state or the address and the age.
 */

/** The narrow layout's threshold, the table's own width: `@2xl/table` is 42 rem. */
const WIDE_ONLY = "hidden @2xl/table:inline-flex"
const NARROW_ONLY = "@2xl/table:hidden"

/** A person's role on the site, beside its name: what they may do there, read at a glance. The owner sees none. */
function RoleTag({ slug }: { slug: string }) {
  const { identity } = useData()
  const role = roleOn(identity, slug)
  if (role === null) return null
  return (
    <span title="Your role" className={cn(CHIP, "text-secondary-foreground")}>
      <RoleBars role={role} />
      <span className="sr-only">Your role: </span>
      {roleLabel(role)}
    </span>
  )
}

/**
 * One of the platform's own projects, which the list shows outside Platform
 * only while it needs the owner. Quieter than a role: it says what the
 * project is, not what to do with it.
 */
function PlatformTag({ site }: { site: Pick<ListedSite, "platform"> }) {
  if (!site.platform) return null
  return (
    <span title="Part of the platform" className={cn(CHIP, "font-normal text-muted-foreground")}>
      {PLATFORM_FACET}
    </span>
  )
}

/**
 * A site taking at least 15 % of the processor, beside its name: "CPU 18%",
 * muted, a fact rather than an issue. The CPU sort ranks every site.
 */
function CpuTag({ site, cores }: { site: ListedSite; cores: number | null }) {
  const share = busyShare(site, cores)
  const cpu = siteWeight(site).cpuShare
  if (share === null || cpu === null) return null
  return (
    <span title={processorTitle(cpu, cores)} className={cn(CHIP, "font-normal text-muted-foreground tabular-nums")}>
      CPU {computeCpuShare(share)}
    </span>
  )
}

/**
 * What a site's running services hold, an 18 px ring of it against their
 * limit and the figure beside it, muted while fine, amber or red near the
 * limit: the one resource a site runs out of, killed and restarted at its
 * limit. Empty when nothing runs.
 */
function MemoryCell({ site }: { site: ListedSite }) {
  const usage = memoryUsage(site)
  if (usage === null) return null
  return <MemoryUsage reading={memoryReading(usage.memory, usage.peak, usage.limit)} className="flex text-[0.8125rem]" />
}

/** The row's word when it has one: its tone, "+2", and every message in the tooltip, the first in strong. */
function RowStateLabel({ state, className }: { state: RowState; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("inline-flex min-w-0", className)} />}>
        <StateLabel tone={state.tone} more={state.more}>
          {state.label}
        </StateLabel>
      </TooltipTrigger>
      <TooltipContent className="grid max-w-80 justify-items-start gap-1 text-left">
        {state.lines.map((line, index) => (
          <span key={`${index}-${line}`} className={index === 0 ? "font-semibold" : "font-normal opacity-85"}>
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The address visitors use, in muted mono, cut with an ellipsis; its arrow
 * shows on hover and focus, in the cell's padding, so that it costs the
 * address no character. A link on a computer only: on two lines the
 * whole row leads to the site's Overview, and a second target inside it
 * would be one a thumb hits by mistake. A project that serves no page says
 * so, in words.
 */
function AddressText({ site }: { site: ListedSite }) {
  const address = siteAddress(site)
  if (site.headless && site.domain === null) {
    return (
      <CellText title={HEADLESS_NOTE} className="text-muted-foreground">
        No page
      </CellText>
    )
  }
  const title = address.note === null ? address.text : `${address.text}\n${address.note.text}`
  return (
    <a
      href={address.href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="group/address relative inline-flex min-w-0 items-center rounded-sm font-mono text-[0.8125rem] text-muted-foreground underline decoration-transparent underline-offset-4 outline-none hover:text-foreground hover:decoration-foreground/40 focus-visible:ring-2 focus-visible:ring-ring @max-2xl/table:pointer-events-none @max-2xl/table:text-xs"
    >
      <span className="min-w-0 truncate">{address.text}</span>
      <ArrowUpRight
        aria-hidden="true"
        className="absolute top-1/2 -right-4 size-3 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-focus-visible/address:opacity-100 @max-2xl/table:hidden"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** What the CPU or the Disk sort brings back: the figure, and the rest of it in its tooltip. */
function FigureCell({ site, which, cores }: { site: ListedSite; which: "cpu" | "disk"; cores: number | null }) {
  const value = figure(site, which)
  if (value === null) return <span className="text-muted-foreground">{ABSENT}</span>
  if (which === "disk") return <span title={`On disk, in ${siteFolder(site.slug)}`}>{size(value)}</span>
  const share = processorShare(value, cores)
  return <span title={processorTitle(value, cores)}>{computeCpuShare(share ?? value)}</span>
}

/** The row menu: where to go first, then what to copy, then the site's sections. */
function SiteMenu({ site }: { site: ListedSite }) {
  const { identity } = useData()
  const { copy } = useCopy("Copied")
  const address = siteAddress(site)
  const access = siteAccess(site)
  const headless = site.headless && site.domain === null
  const sections = sectionsFor(identity, site.slug, site).filter((entry) => entry.section !== "overview")
  return (
    <RowMenu label={`Actions for ${site.slug}`}>
      <DropdownMenuGroup>
        {!headless && (
          <RowMenuLink href={address.href} external>
            <ArrowUpRight />
            Open site
          </RowMenuLink>
        )}
        <DropdownMenuItem className="h-9" onClick={() => void copy(address.href)}>
          <Copy />
          Copy address
        </DropdownMenuItem>
        {access.kind === "code" && access.code !== null && (
          <DropdownMenuItem className="h-9" onClick={() => void copy(access.code ?? "")}>
            <Copy />
            Copy code
          </DropdownMenuItem>
        )}
        {access.kind === "code" && access.url !== null && (
          <DropdownMenuItem className="h-9" onClick={() => void copy(access.url ?? "")}>
            <Link2 />
            Copy link with code
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      {sections.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {sections.map((entry) => {
              const Icon = SECTION_ICONS[entry.section]
              return (
                <RowMenuLink key={entry.section} href={siteUrl(site.slug, entry.section)}>
                  <Icon />
                  {entry.title}
                </RowMenuLink>
              )
            })}
          </DropdownMenuGroup>
        </>
      )}
    </RowMenu>
  )
}

const FIGURE_HEAD = { cpu: "CPU", disk: "Disk" } as const

function siteColumns(
  states: ReadonlyMap<string, RowState>,
  which: "cpu" | "disk" | null,
  now: number,
  serverNow: number,
  cores: number | null,
): Column<ListedSite>[] {
  const site: Column<ListedSite> = {
    key: "site",
    head: "Site",
    width: "minmax(10rem,1.1fr)",
    slot: "primary",
    cell: (row) => {
      const state = states.get(row.slug) ?? null
      return (
        <>
          <KindIcon kind={siteKind(row)} detail={kindDetail(row, now)} />
          {/* The name gives way last: the state's word is cut first, its whole text in its tooltip. */}
          <RowLink href={siteUrl(row.slug)} className="max-w-[calc(100%-1.5rem)] shrink-0">
            <span title={row.description ?? undefined}>{row.slug}</span>
          </RowLink>
          <PlatformTag site={row} />
          <RoleTag slug={row.slug} />
          {/* Sorted by CPU, the column says it on every row. */}
          {which !== "cpu" && <CpuTag site={row} cores={cores} />}
          {state !== null && <RowStateLabel state={state} className={WIDE_ONLY} />}
        </>
      )
    },
  }
  const address: Column<ListedSite> = {
    key: "address",
    head: "Address",
    width: "minmax(8.5rem,1fr)",
    slot: "meta",
    cell: (row) => {
      const state = states.get(row.slug) ?? null
      // On two lines, a row in trouble says its word where the address goes: the address is one tap away.
      if (state === null) return <AddressText site={row} />
      return (
        <>
          <RowStateLabel state={state} className={NARROW_ONLY} />
          <span className={cn("min-w-0", WIDE_ONLY)}>
            <AddressText site={row} />
          </span>
        </>
      )
    },
  }
  const access: Column<ListedSite> = {
    key: "access",
    head: "Access",
    width: "76px",
    align: "center",
    slot: "state",
    // A project that serves no page has no visitor to let in: its cell stays empty.
    cell: (row) => (listedAccess(row) === null ? null : <AccessIcon access={siteAccess(row)} slug={row.slug} />),
  }
  const memory: Column<ListedSite> = {
    key: "memory",
    head: "Memory",
    width: "104px",
    slot: "hide",
    cell: (row) => <MemoryCell site={row} />,
  }
  const deployed: Column<ListedSite> = {
    key: "deployed",
    head: "Deployed",
    width: "96px",
    align: "end",
    // A figure the sort asked for takes the age's place on two lines.
    slot: which === null ? "time" : "hide",
    cell: (row) => <When at={row.deployed} serverNow={serverNow} />,
  }
  if (which === null) return [site, address, access, memory, deployed]
  const extra: Column<ListedSite> = {
    key: which,
    head: FIGURE_HEAD[which],
    width: "88px",
    align: "end",
    slot: "time",
    cell: (row) => <FigureCell site={row} which={which} cores={cores} />,
  }
  return [site, address, access, memory, extra, deployed]
}

/**
 * The list itself, in its panel. `rows` are already narrowed and ordered;
 * `states` holds what each row in trouble says; `which` the figure a Memory
 * or Disk sort brings back; `empty` what replaces the rows when none is left.
 */
export function SiteList({
  rows,
  states,
  which,
  caption,
  empty,
}: {
  rows: readonly ListedSite[]
  states: ReadonlyMap<string, RowState>
  which: "cpu" | "disk" | null
  caption: string
  empty: ReactNode
}) {
  const { now, offset, snapshot } = useData()
  const cores = snapshot?.machine?.cores ?? null
  // The one-line layout needs its tracks' minimums, the row's padding and the menu: 640 px, 668 with the
  // gutter, and 728 or 756 with the figure a sort brings. Below 42 rem, or 48 rem with that figure, the rows
  // take two lines rather than overflow a panel that clips them.
  // The gutter is the line the eye scans for trouble: with none in the list, it is not drawn at all.
  const trouble = rows.some((row) => (states.get(row.slug)?.severity ?? null) !== null)
  return (
    <DataTable
      label="Sites"
      caption={caption}
      rows={rows}
      rowKey={(row) => row.slug}
      columns={siteColumns(states, which, now, now + offset, cores)}
      severity={trouble ? (row) => states.get(row.slug)?.severity ?? null : undefined}
      rowHref={(row) => siteUrl(row.slug)}
      menu={(row) => <SiteMenu site={row} />}
      narrowBelow={which === null ? "42rem" : "48rem"}
      narrowMenu={false}
      empty={empty}
    />
  )
}
