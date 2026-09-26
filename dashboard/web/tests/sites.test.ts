import { describe, expect, test } from "bun:test"
import {
  FILTERS,
  siteAccess,
  siteAddress,
  countFilters,
  inFilter,
  serviceState,
  filterByKind,
  rowClickOutcome,
  sitesCaption,
  computeCpuShare,
  serviceSummaryOf,
  sortSites,
  type RowClick,
} from "../src/lib/sites"
import type { Site } from "../src/lib/types"
import { worstSeverities } from "../src/lib/verdict"
import { discrepancy, service, site } from "./factory"

const MO = 1024 ** 2
const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000

describe("main address", () => {
  const name = "agency.test"

  test("with no domain, the preview address alone", () => {
    expect(siteAddress(site())).toEqual({
      href: "https://calendar.test-zone.invalid",
      text: "calendar.test-zone.invalid",
      note: null,
    })
  })

  test("a domain that is active and routed becomes the main link, the preview address moves below", () => {
    const address = siteAddress(site({ domain: { name, aliases: [], active: true, route: true } }))
    expect(address.href).toBe("https://agency.test")
    expect(address.note).toEqual({ text: "calendar.test-zone.invalid", warn: false })
  })

  test("a domain declared but not activated is pending", () => {
    const address = siteAddress(site({ domain: { name, aliases: [], active: false, route: false } }))
    expect(address.href).toBe("https://calendar.test-zone.invalid")
    expect(address.note).toEqual({ text: "Pending: agency.test", warn: false })
  })

  /** Active but not routed, the domain does not answer: the link stays on the preview address, which does. */
  test("a domain that is active but not routed raises an alert and does not become the link", () => {
    const address = siteAddress(site({ domain: { name, aliases: [], active: true, route: false } }))
    expect(address.href).toBe("https://calendar.test-zone.invalid")
    expect(address.note).toEqual({ text: "agency.test not routed", warn: true })
  })

  test("a domain that is routed but no longer active raises an alert too", () => {
    const address = siteAddress(site({ domain: { name, aliases: [], active: false, route: true } }))
    expect(address.note).toEqual({ text: "agency.test routed, not active", warn: true })
  })
})

describe("a site's door", () => {
  const portal = (wanted: boolean, installed: boolean) => ({ wanted, installed, exemptions: ["/callbacks/*"] })
  const lock = (closed: boolean, code: string | null) => ({
    closed,
    code,
    url: code === null ? null : `https://a.test-zone.invalid/?key=${code}`,
  })

  test("a code in effect on a closed site is shown with its link", () => {
    expect(siteAccess(site({ lock: lock(true, "K7PM4Q") }))).toEqual({
      kind: "code",
      code: "K7PM4Q",
      url: "https://a.test-zone.invalid/?key=K7PM4Q",
    })
  })

  test("the portal is shown with its public paths", () => {
    expect(siteAccess(site({ portal: portal(true, true) }))).toEqual({ kind: "portal", exemptions: ["/callbacks/*"] })
  })

  test("neither lock nor portal: no gate", () => {
    expect(siteAccess(site())).toEqual({ kind: "open" })
  })

  /** The worst possible state: the owner believes the site closed, Caddy serves it in the clear. */
  test("a portal requested but missing from the block is an anomaly, before everything else", () => {
    expect(siteAccess(site({ portal: portal(true, false), lock: lock(true, "K7PM4Q") }))).toEqual({
      kind: "mismatch",
      key: "portal-absent",
      label: "Portal not applied: served unprotected",
    })
  })

  test("every disagreement has its key and its label", () => {
    expect(siteAccess(site({ portal: portal(false, true) }))).toMatchObject({
      key: "portal-extra",
      label: "Portal applied but not requested",
    })
    expect(siteAccess(site({ lock: lock(false, "K7PM4Q") }))).toMatchObject({
      key: "code-without-lock",
      label: "Code without lock",
    })
    expect(siteAccess(site({ lock: lock(true, null) }))).toMatchObject({
      key: "lock-without-code",
      label: "Lock has no code",
    })
  })
})

describe("a service's state", () => {
  test("an active service is running", () => {
    expect(serviceState(site())).toEqual({ tone: "ok", label: "Running" })
  })

  test("a static site serves files, without judgement", () => {
    expect(serviceState(site({ type: "static", service: null }))).toEqual({ tone: "neutral", label: "Static files" })
  })

  test("a folder with no manifest and no unit has no service to judge", () => {
    expect(serviceState(site({ type: "no-manifest", service: null }))).toEqual({ tone: "neutral", label: "No manifest" })
  })

  /** As in the server's discrepancies: any app that is not running is an error. */
  test("an app that is not running is in error, and the word says how", () => {
    expect(serviceState(site({ service: null }))).toEqual({ tone: "error", label: "Down" })
    expect(serviceState(site({ service: service({ active: "failed", subState: "failed" }) }))).toEqual({
      tone: "error",
      label: "Down",
    })
    expect(serviceState(site({ service: service({ active: "inactive", subState: "dead" }) }))).toMatchObject({ label: "Down" })
    expect(serviceState(site({ service: service({ active: "activating", subState: "auto-restart" }) }))).toEqual({
      tone: "error",
      label: "Restarting",
    })
    expect(serviceState(site({ service: service({ active: "activating", subState: "start" }) }))).toMatchObject({
      tone: "error",
      label: "Starting",
    })
    expect(serviceState(site({ service: service({ active: "deactivating", subState: "stop" }) }))).toMatchObject({
      label: "Stopping",
    })
  })
})

describe("a service's summary", () => {
  test("a static site has no service, and that is not a failure", () => {
    expect(serviceSummaryOf(site({ type: "static", service: null }), NOW)).toEqual({ kind: "static" })
  })

  test("an app with no loaded unit is stopped", () => {
    expect(serviceSummaryOf(site({ service: null }), NOW)).toEqual({
      kind: "stopped",
      state: "not loaded",
      restarts: null,
    })
  })

  test("a folder with no manifest and no unit has nothing to show", () => {
    expect(serviceSummaryOf(site({ type: "no-manifest", service: null }), NOW)).toEqual({ kind: "none" })
  })

  test("a downed service shows its state and its restarts", () => {
    expect(serviceSummaryOf(site({ service: service({ active: "activating", restarts: 7 }) }), NOW)).toEqual({
      kind: "stopped",
      state: "activating",
      restarts: "7 restarts",
    })
  })

  test("an active service shows its memory over its ceiling, its CPU share and its uptime", () => {
    const summary = serviceSummaryOf(
      site({
        service: service({ memory: 61 * MO, peak: 88 * MO, limit: 256 * MO, since: NOW - 13 * DAY, cpuShare: 3.4 }),
      }),
      NOW,
    )
    expect(summary).toEqual({
      kind: "active",
      memory: "61 of 256 MB",
      percent: 24,
      level: "normal",
      cpu: "3% CPU",
      since: "up 13d",
      restarts: null,
    })
  })

  test("with no ceiling, the memory alone and no bar", () => {
    expect(serviceSummaryOf(site({ service: service({ memory: 61 * MO, limit: null }) }), NOW)).toMatchObject({
      memory: "61 MB",
      percent: null,
    })
  })

  test("with no measured CPU share and no date, nothing is written rather than a zero", () => {
    expect(serviceSummaryOf(site({ service: service({ since: null, cpuShare: null }) }), NOW)).toMatchObject({
      cpu: null,
      since: null,
    })
  })

  test("the restarts are counted, singular as well as plural", () => {
    expect(serviceSummaryOf(site({ service: service({ restarts: 4 }) }), NOW)).toMatchObject({
      restarts: "4 restarts",
    })
    expect(serviceSummaryOf(site({ service: service({ restarts: 1 }) }), NOW)).toMatchObject({
      restarts: "1 restart",
    })
  })

  /** The bar follows the service's thresholds: the peak warns, the current memory alarms. */
  test("the bar is capped at one hundred and takes the service's level", () => {
    expect(serviceSummaryOf(site({ service: service({ memory: 300 * MO, limit: 256 * MO }) }), NOW)).toMatchObject({
      percent: 100,
      level: "critical",
    })
    expect(
      serviceSummaryOf(site({ service: service({ memory: 120 * MO, peak: 210 * MO, limit: 256 * MO }) }), NOW),
    ).toMatchObject({ level: "warn" })
  })

  test("a tiny share of a core is not rounded to zero", () => {
    expect(computeCpuShare(0.3)).toBe("<1%")
    expect(computeCpuShare(0)).toBe("0%")
    expect(computeCpuShare(142.6)).toBe("143%")
  })
})

describe("filters", () => {
  const calendar = site({ slug: "calendar", portal: { wanted: true, installed: true, exemptions: [] } })
  const cms = site({ slug: "cms" })
  const showcase = site({ slug: "showcase", type: "static", service: null, port: null })
  const forgotten = site({ slug: "forgotten", type: "no-manifest", service: null, port: null })
  const expose = site({
    slug: "expose",
    type: "static",
    service: null,
    portal: { wanted: true, installed: false, exemptions: [] },
  })
  const SITES = [calendar, cms, showcase, forgotten, expose]
  const worst = worstSeverities([discrepancy("warning", "cms"), discrepancy("error", "expose"), discrepancy("error", null)])
  const slugs = (sites: Site[]) => sites.map((s) => s.slug)

  test("All keeps everything, in the order received", () => {
    expect(filterByKind(SITES, "all", worst)).toEqual(SITES)
  })

  test("Issues keeps the sites that have them, of any severity, and never the machine", () => {
    expect(slugs(filterByKind(SITES, "issues", worst))).toEqual(["cms", "expose"])
  })

  test("Apps and Static, without the folders that have no manifest", () => {
    expect(slugs(filterByKind(SITES, "apps", worst))).toEqual(["calendar", "cms"])
    expect(slugs(filterByKind(SITES, "static", worst))).toEqual(["showcase", "expose"])
    expect(inFilter(forgotten, "apps", worst) || inFilter(forgotten, "static", worst)).toBe(false)
  })

  /** A portal requested but missing is precisely what you come looking for under this filter. */
  test("Portal also keeps the disagreements, both ways round", () => {
    const extra = site({ slug: "extra", portal: { wanted: false, installed: true, exemptions: [] } })
    expect(slugs(filterByKind([...SITES, extra], "portal", worst))).toEqual(["calendar", "expose", "extra"])
  })

  test("every filter counts what it would keep", () => {
    expect(countFilters(SITES, worst)).toEqual({ all: 5, issues: 2, apps: 2, static: 2, portal: 2 })
    expect(countFilters([], worst)).toEqual({ all: 0, issues: 0, apps: 0, static: 0, portal: 0 })
  })

  /** Every chip's count comes from the same table as the chips: a filter added has its place there. */
  test("All comes first, and every filter has its count", () => {
    expect(FILTERS[0]?.key).toBe("all")
    expect(Object.keys(countFilters(SITES, worst)).sort()).toEqual(FILTERS.map((filter) => filter.key).sort())
  })
})

describe("order of the inventory", () => {
  test("errors, then warnings, then the rest, each group by name", () => {
    const sites = ["zoo", "beta", "alpha", "cms", "mid", "calendar"].map((slug) => site({ slug }))
    const worst = worstSeverities([
      discrepancy("warning", "mid"),
      discrepancy("error", "zoo"),
      discrepancy("warning", "calendar"),
      discrepancy("error", "cms"),
      discrepancy("warning", "cms"),
    ])
    expect(sortSites(sites, worst).map((s) => s.slug)).toEqual(["cms", "zoo", "calendar", "mid", "alpha", "beta"])
  })

  test("with no discrepancy, alphabetical order, without touching the list received", () => {
    const sites = [site({ slug: "b" }), site({ slug: "a" })]
    expect(sortSites(sites, new Map()).map((s) => s.slug)).toEqual(["a", "b"])
    expect(sites.map((s) => s.slug)).toEqual(["b", "a"])
  })
})

describe("click on a row", () => {
  const click = (partial: Partial<RowClick> = {}): RowClick => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...partial,
  })

  test("a plain click opens the card inside the page", () => {
    expect(rowClickOutcome(click(), false, "")).toBe("page")
  })

  test("Cmd, Ctrl and the middle button open a new tab, as on a link", () => {
    expect(rowClickOutcome(click({ metaKey: true }), false, "")).toBe("tab")
    expect(rowClickOutcome(click({ ctrlKey: true }), false, "")).toBe("tab")
    expect(rowClickOutcome(click({ button: 1 }), false, "")).toBe("tab")
  })

  test("a click on a link, a button or a field belongs to it", () => {
    expect(rowClickOutcome(click(), true, "")).toBeNull()
    expect(rowClickOutcome(click({ button: 1 }), true, "")).toBeNull()
    expect(rowClickOutcome(click({ defaultPrevented: true }), false, "")).toBeNull()
  })

  /** Selecting an address or a number to copy it must not leave the page. */
  test("a click that ends a text selection does not navigate", () => {
    expect(rowClickOutcome(click(), false, "cms.test-zone.invalid")).toBeNull()
  })

  test("the right click, Shift and Alt do nothing", () => {
    expect(rowClickOutcome(click({ button: 2 }), false, "")).toBeNull()
    expect(rowClickOutcome(click({ shiftKey: true }), false, "")).toBeNull()
    expect(rowClickOutcome(click({ altKey: true }), false, "")).toBeNull()
  })
})

describe("the table's caption", () => {
  test("it states the order, then the filter and the search when there are any", () => {
    expect(sitesCaption("all", null)).toBe("Sites served by the server, issues first, then by name")
    expect(sitesCaption("portal", null)).toBe("Sites served by the server, issues first, then by name, filtered by Portal")
    expect(sitesCaption("all", "cms")).toBe('Sites served by the server, issues first, then by name, matching "cms"')
  })
})
