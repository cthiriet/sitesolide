import { describe, expect, test } from "bun:test"
import { readListState } from "../src/lib/list-state"
import {
  BANNERS_SHOWN,
  PENDING_LINE,
  SITES_LIST,
  SITE_SORTS,
  busyShare,
  facetValues,
  figureOf,
  kindDetail,
  listed,
  memoryUsage,
  narrowSites,
  narrowedSites,
  rowState,
  rowlessIssues,
  sitesCaption,
  sortSites,
  type ListedSite,
} from "../src/lib/site-list"
import { countBySeverity, worstSeverities } from "../src/lib/verdict"
import { discrepancy, scheduledService, service, site, siteService } from "./factory"

const NOW = 1_800_000_000_000
const MB = 1024 ** 2
const state = (search = "") => readListState(new URLSearchParams(search), SITES_LIST)
const slugs = (sites: readonly { slug: string }[]) => sites.map((entry) => entry.slug)

const restricted = { wanted: true, installed: true, exemptions: [] }
const calendar = site({ slug: "calendar", portal: restricted })
const cms = site({ slug: "cms" })
const showcase = site({ slug: "showcase", type: "static", service: null, port: null })
const forgotten = site({ slug: "forgotten", type: "no-manifest", service: null, port: null })
const expose = site({ slug: "expose", type: "static", service: null, portal: { wanted: true, installed: false, exemptions: [] } })
const wheels = site({ slug: "wheels", type: "static", service: null, lock: { closed: true, code: "K7PX3M", url: "https://wheels.test-zone.invalid/?code=K7PX3M" } })
const courier = site({ slug: "courier", headless: true, services: [siteService({ main: true, kind: "server" }), siteService({ kind: "worker" })] })
const SITES = [calendar, cms, showcase, forgotten, expose, wheels, courier]

describe("the facets", () => {
  test("a site's access and kind, as the row's icons say them, no access for a project that serves no page", () => {
    expect(facetValues(calendar)).toEqual({ access: ["restricted"], kind: ["app"] })
    expect(facetValues(showcase)).toEqual({ access: ["public"], kind: ["static"] })
    expect(facetValues(expose)).toEqual({ access: ["mismatch"], kind: ["static"] })
    expect(facetValues(wheels)).toEqual({ access: ["code"], kind: ["static"] })
    expect(facetValues(courier)).toEqual({ access: [], kind: ["background"] })
    expect(facetValues(forgotten)).toEqual({ access: ["public"], kind: ["none"] })
    expect(facetValues(site({ slug: "portal", platform: true }))).toEqual({ access: ["public"], kind: ["app", "platform"] })
  })

  test("each value keeps its sites, and the access counts add up to the projects that serve a page", () => {
    const healthy = worstSeverities([])
    expect(slugs(narrowSites(SITES, healthy, state("access=restricted")).rows)).toEqual(["calendar"])
    expect(slugs(narrowSites(SITES, healthy, state("access=code")).rows)).toEqual(["wheels"])
    expect(slugs(narrowSites(SITES, healthy, state("kind=static")).rows)).toEqual(["showcase", "expose", "wheels"])
    const { counts, total } = narrowSites(SITES, healthy, state())
    expect(counts.access).toEqual({ restricted: 1, public: 3, mismatch: 1, code: 1 })
    expect(counts.kind).toEqual({ app: 2, static: 3, none: 1, background: 1, platform: 0 })
    expect(Object.values(counts.access).reduce((a, b) => a + b)).toBe(total - 1)
  })

  /** A facet's menu says what choosing each value would show: under the search and the other facet, never under itself. */
  test("the counts are faceted", () => {
    const narrowed = narrowSites(SITES, worstSeverities([]), state("kind=static&access=public"))
    expect(slugs(narrowed.rows)).toEqual(["showcase"])
    expect(narrowed.counts.access).toEqual({ public: 1, mismatch: 1, code: 1 })
    // courier serves no page: no access keeps it, so Public counts no Background.
    expect(narrowed.counts.kind).toMatchObject({ app: 1, static: 1, none: 1 })
    expect(narrowed.counts.kind.background).toBeUndefined()
  })

  test("a facet offers the values some project has, and the one chosen even when none has it any more", () => {
    const healthy = worstSeverities([])
    expect(narrowSites([cms, showcase], healthy, state()).offered).toEqual({ access: ["public"], kind: ["static", "app"] })
    expect(narrowSites([cms], healthy, state("access=mismatch")).offered.access).toEqual(["public", "mismatch"])
    expect(narrowSites(SITES, healthy, state()).offered.access).toEqual(["public", "restricted", "code", "mismatch"])
  })

  test("the search narrows the rows and the counts together", () => {
    const narrowed = narrowSites(SITES, worstSeverities([]), state("q=showcase"))
    expect(slugs(narrowed.rows)).toEqual(["showcase"])
    expect(narrowed.counts.access).toEqual({ public: 1 })
    expect(narrowed.total).toBe(SITES.length)
  })

  /** "Background" and "Static site" are words the row shows, in its kind's tooltip. */
  test("the search finds a site by its kind's words", () => {
    expect(slugs(narrowSites(SITES, worstSeverities([]), state("q=background")).rows)).toEqual(["courier"])
    expect(slugs(narrowSites(SITES, worstSeverities([]), state("q=mismatch")).rows)).toEqual(["expose"])
  })

  test("3 of 14 only while a search, an access or a kind narrows the list, Platform alone counting its own", () => {
    expect(narrowedSites(state())).toBe(false)
    expect(narrowedSites(state("sort=name"))).toBe(false)
    expect(narrowedSites(state("q=cms"))).toBe(true)
    expect(narrowedSites(state("access=public"))).toBe(true)
    expect(narrowedSites(state("kind=app"))).toBe(true)
    expect(narrowedSites(state("kind=platform"))).toBe(false)
    expect(narrowedSites(state("kind=platform&q=port"))).toBe(true)
  })
})

describe("the platform's own projects", () => {
  const shop = site({ slug: "shop" })
  const dashboard = site({ slug: "dashboard", platform: true, port: 3022 })
  const portal = site({ slug: "portal", platform: true, port: 3026, portal: restricted })
  const analytics = site({ slug: "analytics", platform: true, type: "static", service: null, port: null })
  const FLEET = [shop, dashboard, portal, analytics]
  const healthy = worstSeverities([])

  test("the list leaves out the healthy ones, and Platform lists every one of them", () => {
    expect(slugs(narrowSites(FLEET, healthy, state()).rows)).toEqual(["shop"])
    expect(slugs(narrowSites(FLEET, healthy, state("kind=platform")).rows)).toEqual(["dashboard", "portal", "analytics"])
  })

  /** A broken portal is exactly what the owner must see, at the top of the list. */
  test("one with an issue, or a restart pending, is listed with the others", () => {
    for (const severity of ["error", "warning"] as const) {
      const worst = worstSeverities([discrepancy(severity, "portal")])
      expect(slugs(narrowSites(FLEET, worst, state()).rows)).toEqual(["shop", "portal"])
      expect(slugs(narrowSites(FLEET, worst, state("access=restricted")).rows)).toEqual(["portal"])
    }
    expect(listed({ ...portal, restartPending: true }, healthy)).toBe(true)
    expect(listed({ ...portal, restartPending: false }, healthy)).toBe(false)
  })

  test("the header counts what the list holds, or the platform's own under Platform", () => {
    expect(narrowSites(FLEET, healthy, state()).total).toBe(1)
    expect(narrowSites(FLEET, healthy, state("kind=app")).total).toBe(1)
    expect(narrowSites(FLEET, healthy, state("kind=platform")).total).toBe(3)
    expect(narrowSites(FLEET, worstSeverities([discrepancy("error", "portal")]), state()).total).toBe(2)
  })

  /** Every value but Platform keeps a part of what the list holds: no facet's count exceeds the header's. */
  test("Platform counts all of them, every other value what the list holds", () => {
    const { counts } = narrowSites(FLEET, healthy, state())
    expect(counts.kind).toEqual({ app: 1, platform: 3 })
    expect(counts.access).toEqual({ public: 1 })
    const under = narrowSites(FLEET, healthy, state("kind=platform"))
    expect(under.counts.access).toEqual({ public: 2, restricted: 1 })
    expect(under.counts.kind).toEqual({ app: 1, platform: 3 })
  })

  test("Platform is offered only while there is one of them", () => {
    expect(narrowSites(FLEET, healthy, state()).offered.kind).toContain("platform")
    expect(narrowSites([shop], healthy, state()).offered.kind).not.toContain("platform")
  })

  test("a fresh machine holds nothing, and Platform everything", () => {
    const fresh = [dashboard, portal, analytics]
    expect(narrowSites(fresh, healthy, state()).rows).toEqual([])
    expect(narrowSites(fresh, healthy, state()).total).toBe(0)
    expect(narrowSites(fresh, healthy, state()).counts.kind.platform).toBe(3)
  })

  test("a search that finds only platform projects says how many", () => {
    expect(narrowSites(FLEET, healthy, state("q=portal")).platformMatches).toBe(1)
    expect(narrowSites(FLEET, healthy, state("q=shop")).platformMatches).toBe(0)
    expect(narrowSites(FLEET, healthy, state("q=portal&kind=platform")).platformMatches).toBe(0)
  })
})

describe("what a row says", () => {
  test("a fine row says nothing", () => {
    expect(rowState(cms, [])).toBeNull()
    expect(rowState(cms, [discrepancy("error", "calendar"), discrepancy("warning", null)])).toBeNull()
  })

  /** The server names each discrepancy: the row reads its label, never its message. */
  test("its first issue's label, errors first, then how many more, every message whole", () => {
    const issues = [
      discrepancy("warning", "roster", "Memory peak at 86% of the limit", "Memory 86%"),
      discrepancy("error", "roster", "Service activating (auto-restart)", "Restarting"),
      discrepancy("error", "roster", "Port 3045 declared, but nothing listens on it", "Port not listening"),
    ]
    expect(rowState(site({ slug: "roster" }), issues)).toEqual({
      severity: "error",
      tone: "error",
      label: "Restarting",
      more: 2,
      lines: ["Service activating (auto-restart)", "Port 3045 declared, but nothing listens on it", "Memory peak at 86% of the limit"],
    })
    expect(rowState(site({ slug: "cms" }), [discrepancy("warning", "cms", "m", "Memory 86%")])).toMatchObject({
      severity: "warning",
      tone: "attention",
      label: "Memory 86%",
      more: 0,
    })
  })

  /** A change waiting for its owner, not a fault the server found: its word, never the gutter, which counts what the verdict counts. */
  test("a restart pending says so in attention, without a gutter icon, after any issue", () => {
    expect(rowState({ slug: "builder", restartPending: true }, [])).toEqual({
      severity: null,
      tone: "attention",
      label: "Restart pending",
      more: 0,
      lines: [PENDING_LINE],
    })
    const both = rowState({ slug: "courier", restartPending: true }, [discrepancy("warning", "courier", "Service cleanup: last run failed", "Last run failed")])
    expect(both).toMatchObject({ severity: "warning", label: "Last run failed", more: 0 })
    expect(both?.lines).toEqual(["Service cleanup: last run failed", PENDING_LINE])
  })

  /** The sidebar's badge and the verdict count every discrepancy: the rows' labels with their "+N", and the banners, count the same. */
  test("every issue is said once, by a row or a banner", () => {
    const issues = [
      discrepancy("error", "cms"),
      discrepancy("error", "cms"),
      discrepancy("warning", "calendar"),
      discrepancy("warning", null),
      discrepancy("warning", "old-kiosk"),
    ]
    const rows = SITES.map((entry) => rowState(entry, issues)).filter((entry) => entry !== null)
    const said = rows.reduce((sum, entry) => sum + (entry.severity === null ? 0 : 1 + entry.more), 0) + rowlessIssues(issues, SITES).length
    const { errors, warnings } = countBySeverity(issues)
    expect(said).toBe(errors + warnings)
  })

  test("the server's own issues and an orphan's have no row: errors first, two shown", () => {
    const issues = [discrepancy("warning", null, "load"), discrepancy("warning", "old-kiosk", "fragment"), discrepancy("error", null, "codes"), discrepancy("error", "cms")]
    expect(rowlessIssues(issues, SITES).map((issue) => issue.message)).toEqual(["codes", "load", "fragment"])
    expect(BANNERS_SHOWN).toBe(2)
  })

  test("the kind's tooltip says what the row knows beyond its word", () => {
    expect(kindDetail(cms, NOW)).toBeUndefined()
    expect(kindDetail(site({ services: [siteService({ main: true }), siteService(), siteService()] }), NOW)).toBe("Serves pages through 3 services.")
    expect(kindDetail(courier, NOW)).toBe("Runs 2 services in the background, serves no page.")
    const reports = site({
      headless: true,
      service: service({ subState: "exited", memory: null, peak: null, limit: null, cpuShare: null }),
      services: [scheduledService(NOW, { name: "weekly", unit: "reports.weekly" }, { next: NOW + 5 * 3600_000 })],
    })
    expect(kindDetail(reports, NOW)).toBe("Runs on a schedule, serves no page. Next run in 5h.")
  })
})

describe("the order", () => {
  const healthy = worstSeverities([])

  test("Issues first: errors, warnings, a restart pending, then the rest, each group by name", () => {
    const sites: ListedSite[] = ["zoo", "beta", "alpha", "cms", "mid", "calendar"].map((slug) => site({ slug }))
    sites[1] = { ...sites[1]!, restartPending: true }
    const worst = worstSeverities([
      discrepancy("warning", "mid"),
      discrepancy("error", "zoo"),
      discrepancy("warning", "calendar"),
      discrepancy("error", "cms"),
      discrepancy("warning", "cms"),
    ])
    expect(slugs(sortSites(sites, "issues", worst))).toEqual(["cms", "zoo", "calendar", "mid", "beta", "alpha"])
    expect(slugs(sortSites(sites, null, worst))).toEqual(["cms", "zoo", "calendar", "mid", "beta", "alpha"])
  })

  test("Name, without touching the list received", () => {
    const sites = [site({ slug: "b" }), site({ slug: "a" })]
    expect(slugs(sortSites(sites, "name", worstSeverities([discrepancy("error", "b")])))).toEqual(["a", "b"])
    expect(slugs(sites)).toEqual(["b", "a"])
  })

  test("Last deployed, the newest first, a site never deployed last", () => {
    const sites = [site({ slug: "old", deployed: NOW - 9e6 }), site({ slug: "never", deployed: null }), site({ slug: "new", deployed: NOW })]
    expect(slugs(sortSites(sites, "deployed", healthy))).toEqual(["new", "old", "never"])
  })

  test("CPU, Memory and Disk, the heaviest first, a site with no figure last; CPU and Disk bring their column", () => {
    const heavy = site({ slug: "heavy", service: service({ memory: 300 * MB, cpuShare: 4 }), bytes: 1 * MB })
    const light = site({ slug: "light", service: service({ memory: 30 * MB, cpuShare: 120 }), bytes: 900 * MB })
    const files = site({ slug: "files", type: "static", service: null, bytes: 50 * MB })
    expect(slugs(sortSites([files, light, heavy], "cpu", healthy))).toEqual(["light", "heavy", "files"])
    expect(slugs(sortSites([files, light, heavy], "memory", healthy))).toEqual(["heavy", "light", "files"])
    expect(slugs(sortSites([files, light, heavy], "disk", healthy))).toEqual(["light", "files", "heavy"])
    // Memory has its column always.
    expect(figureOf("cpu")).toBe("cpu")
    expect(figureOf("memory")).toBeNull()
    expect(figureOf("disk")).toBe("disk")
    expect(figureOf("name")).toBeNull()
    expect(figureOf(null)).toBeNull()
  })

  test("the sorts, Issues first the default", () => {
    expect(SITE_SORTS.map((sort) => sort.label)).toEqual(["Issues first", "Name", "Last deployed", "CPU", "Memory", "Disk"])
    expect(state().sort).toBe("issues")
    expect(state("sort=bogus").sort).toBe("issues")
  })
})

describe("what a row says of its usage", () => {
  test("a site taking 15 % of the processor or more is named, as a share of every core", () => {
    // 6 cores: 90 % of one core is 15 % of the processor, 84 % is 14 %.
    expect(busyShare(site({ service: service({ cpuShare: 90 }) }), 6)).toBe(15)
    expect(busyShare(site({ service: service({ cpuShare: 84 }) }), 6)).toBeNull()
    expect(busyShare(site({ service: service({ cpuShare: 300 }) }), 2)).toBe(150)
    // No share without the number of cores, nor without a measure.
    expect(busyShare(site({ service: service({ cpuShare: 300 }) }), null)).toBeNull()
    expect(busyShare(site({ service: service({ cpuShare: null }) }), 6)).toBeNull()
    expect(busyShare(site({ type: "static", service: null }), 6)).toBeNull()
  })

  test("memory against its limit, at the service's own bounds, nothing when nothing runs", () => {
    expect(memoryUsage(site({ service: service({ memory: 64 * MB, peak: 80 * MB, limit: 256 * MB }) }))).toEqual({
      memory: 64 * MB,
      limit: 256 * MB,
      share: 25,
      level: "normal",
    })
    // A peak at 80 % of the limit warns, as the server's discrepancy does; past 90 % now, critical.
    expect(memoryUsage(site({ service: service({ memory: 100 * MB, peak: 205 * MB, limit: 256 * MB }) }))?.level).toBe("warn")
    expect(memoryUsage(site({ service: service({ memory: 240 * MB, peak: 250 * MB, limit: 256 * MB }) }))?.level).toBe("critical")
    expect(memoryUsage(site({ service: service({ memory: 40 * MB, peak: null, limit: null }) }))).toEqual({ memory: 40 * MB, limit: null, share: null, level: "normal" })
    expect(memoryUsage(site({ type: "static", service: null }))).toBeNull()
    expect(memoryUsage(site({ service: service({ active: "failed" }) }))).toBeNull()
  })
})

describe("the table's caption", () => {
  test("it states the order, then what narrows the list", () => {
    expect(sitesCaption("issues", state())).toBe("Sites served by the server, issues first, then by name")
    expect(sitesCaption("memory", state("sort=memory"))).toBe("Sites served by the server, by memory")
    expect(sitesCaption("cpu", state("sort=cpu"))).toBe("Sites served by the server, by CPU")
    expect(sitesCaption("issues", state("access=restricted&kind=app&q=cal"))).toBe(
      'Sites served by the server, issues first, then by name, access restricted, kind app, matching "cal"',
    )
    expect(sitesCaption("issues", state("kind=platform"))).toBe("Sites served by the server, issues first, then by name, the platform's own projects")
  })
})
