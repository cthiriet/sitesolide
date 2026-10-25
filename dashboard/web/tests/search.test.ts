import { describe, expect, test } from "bun:test"
import {
  searchAnnouncement,
  isTyping,
  filterSites,
  countLabel,
  countNoun,
  queryWords,
  normalize,
  searchShortcut,
  type KeyPress,
} from "../src/lib/search"
import { TYPE_LABELS } from "../src/lib/sites"
import type { Site } from "../src/lib/types"
import { scheduledService, service, site, siteService } from "./factory"

const portal = (exemptions: string[] = []) => ({ wanted: true, installed: true, exemptions })

const calendar = site({ slug: "calendar", description: "Agenda partagé", portal: portal(["/callbacks/*"]) })
const cms = site({
  slug: "cms",
  description: "Content management",
  address: "cms.test-zone.invalid",
  port: 3048,
  portal: portal(["/hooks/*"]),
})
const dashboard = site({
  slug: "dashboard",
  description: "Dashboard for the machine",
  address: "dashboard.test-zone.invalid",
  port: 3022,
})
const builder = site({
  slug: "builder",
  description: "Intégration continue des dépôts",
  address: "builder.test-zone.invalid",
  port: 3041,
})
const showcase = site({
  slug: "wheels",
  description: null,
  type: "static",
  port: null,
  service: null,
  address: "wheels.test-zone.invalid",
  domain: { name: "sample-wheels.test", aliases: ["www.sample-wheels.test"], active: true, route: true },
  lock: { closed: true, code: "K7PM4Q", url: "https://wheels.test-zone.invalid/?key=K7PM4Q" },
})

const SITES = [calendar, cms, dashboard, builder, showcase]
const slugs = (sites: Site[]) => sites.map((s) => s.slug)
const found = (query: string) => slugs(filterSites(SITES, query))

describe("normalisation", () => {
  test("case does not count", () => {
    expect(normalize("CMS Portal")).toBe("cms portal")
  })

  test("accents fall away, capitals included", () => {
    expect(normalize("Réunion À l'été")).toBe("reunion a l'ete")
    expect(normalize("ÉTÉ")).toBe("ete")
  })

  test("ligatures are written as two letters", () => {
    expect(normalize("Cœur Ex æquo")).toBe("coeur ex aequo")
  })
})

describe("a query's words", () => {
  test("spaces, even repeated or at the edges, separate the words", () => {
    expect(queryWords("  cms \t Portal\n")).toEqual(["cms", "portal"])
  })

  test("a query that is empty or made of spaces has no word", () => {
    expect(queryWords("")).toEqual([])
    expect(queryWords("   \t ")).toEqual([])
  })

  /** The table only shows the host: an address pasted from the browser has to find it again. */
  test("a pasted address is reduced to its host", () => {
    expect(queryWords("https://cms.test-zone.invalid/")).toEqual(["cms.test-zone.invalid"])
    expect(queryWords("http://cms.test-zone.invalid")).toEqual(["cms.test-zone.invalid"])
    expect(found("https://cms.test-zone.invalid/")).toEqual(["cms"])
  })
})

describe("fields covered", () => {
  test("the slug", () => {
    expect(found("builder")).toEqual(["builder"])
  })

  test("the description, regardless of accents and case, both ways round", () => {
    expect(found("depots")).toEqual(["builder"])
    expect(found("PARTAGÉ")).toEqual(["calendar"])
    expect(slugs(filterSites([site({ description: "Developpement" })], "développement"))).toEqual(["calendar"])
  })

  test("the preview address, the domain and its aliases", () => {
    expect(found("dashboard.test-zone")).toEqual(["dashboard"])
    expect(found("sample-wheels.test")).toEqual(["wheels"])
    expect(found("www.sample-wheels")).toEqual(["wheels"])
    expect(found("wheels.test-zone.invalid")).toEqual(["wheels"])
  })

  /** The address note is shown under the link: what it says is searchable too. */
  test("the note of a pending domain", () => {
    const wait = site({ slug: "salon", domain: { name: "salon.test", aliases: [], active: false, route: false } })
    expect(slugs(filterSites([wait, cms], "pending"))).toEqual(["salon"])
  })

  test("the displayed type", () => {
    expect(found("static")).toEqual(["wheels"])
    expect(found("app")).toEqual(["calendar", "cms", "dashboard", "builder"])
  })

  /** The label comes from lib/sites: if it changes, the search follows without being touched. */
  test("every type label finds its site again", () => {
    for (const [type, label] of Object.entries(TYPE_LABELS)) {
      const candidate = site({ type: type as Site["type"], port: null })
      expect(filterSites([candidate], label)).toHaveLength(1)
    }
  })

  /** The tag is read beside the name: "platform" finds the platform's own projects, and only them. */
  test("the Platform tag of the platform's own projects", () => {
    const own = site({ slug: "portal", platform: true, port: 3026 })
    expect(slugs(filterSites([own, ...SITES], "platform"))).toEqual(["portal"])
  })

  test("the port, with or without its colon", () => {
    expect(found("3048")).toEqual(["cms"])
    expect(found(":3041")).toEqual(["builder"])
  })

  test("general access: restricted, public, anyone with the code and its code", () => {
    expect(found("restricted")).toEqual(["calendar", "cms"])
    expect(found("public")).toEqual(["dashboard", "builder"])
    expect(found("k7pm4q")).toEqual(["wheels"])
    expect(found("with the code")).toEqual(["wheels"])
  })

  /** The service's state is shown on every row: a downed service is found again by its word. */
  test("the service's state", () => {
    const tombe = site({ slug: "roster", service: service({ active: "activating", subState: "auto-restart" }) })
    expect(slugs(filterSites([tombe, cms, showcase], "restarting"))).toEqual(["roster"])
    expect(slugs(filterSites([tombe, cms, showcase], "running"))).toEqual(["cms"])
    expect(slugs(filterSites([tombe, cms, showcase], "static files"))).toEqual(["wheels"])
  })

  test("the public paths of a restricted site", () => {
    expect(found("/hooks")).toEqual(["cms"])
  })

  test("an access anomaly is searched by its label", () => {
    const expose = site({ slug: "kanban", portal: { wanted: true, installed: false, exemptions: [] } })
    expect(slugs(filterSites([expose, cms], "public on the server"))).toEqual(["kanban"])
  })

  /**
   * A project that runs in the background: its note, its anchor's word, and
   * its other services by name, Background for a worker and schedule for a
   * scheduled one, as its Overview shows them.
   */
  test("a project that serves no page, its worker and its schedules", () => {
    const NOW = 1_800_000_000_000
    const courier = site({
      slug: "courier",
      headless: true,
      port: null,
      services: [
        siteService({ name: "queue", unit: "courier", main: true, kind: "worker", internal: true }),
        scheduledService(NOW, { name: "digest", unit: "courier.digest" }, { expression: "Mon..Fri 08:00" }),
        scheduledService(NOW, { name: "cleanup", unit: "courier.cleanup" }),
      ],
    })
    const reports = site({
      slug: "reports",
      headless: true,
      port: null,
      service: service({ subState: "exited" }),
      services: [scheduledService(NOW, { name: "weekly", unit: "reports.weekly" }, { expression: "Mon 07:00" })],
    })
    const all = [courier, reports, cms, showcase]
    expect(slugs(filterSites(all, "serves no page"))).toEqual(["courier", "reports"])
    expect(slugs(filterSites(all, "digest"))).toEqual(["courier"])
    expect(slugs(filterSites(all, "hourly"))).toEqual(["courier"])
    expect(slugs(filterSites(all, "mon..fri"))).toEqual(["courier"])
    expect(slugs(filterSites(all, "weekly 07:00"))).toEqual(["reports"])
    expect(slugs(filterSites(all, "scheduled"))).toEqual(["reports"])
    // The main service is the row's, said by its word: not repeated as a name.
    expect(slugs(filterSites(all, "queue"))).toEqual([])
  })

  /** The preview link carries the code as a parameter, but only the code is displayed. */
  test("what is not displayed is not searchable", () => {
    expect(found("key=")).toEqual([])
    expect(found("https")).toEqual([])
  })
})

describe("secrets", () => {
  const cmsWithSecrets = { ...cms, variables: ["CMS_TOKEN", "SMTP_PASSWORD"], restartPending: true }
  const withSecretsList = [calendar, cmsWithSecrets, dashboard, builder, showcase]

  /** A key is searched by its name, in capitals or not, whole or in part. */
  test("a variable's name finds its site again", () => {
    expect(slugs(filterSites(withSecretsList, "SMTP_PASSWORD"))).toEqual(["cms"])
    expect(slugs(filterSites(withSecretsList, "cms_token"))).toEqual(["cms"])
    expect(slugs(filterSites(withSecretsList, "smtp"))).toEqual(["cms"])
  })

  test("the restart pending pill is searched as it is displayed", () => {
    expect(slugs(filterSites(withSecretsList, "restart pending"))).toEqual(["cms"])
    expect(slugs(filterSites([{ ...cmsWithSecrets, restartPending: false }], "pending"))).toEqual([])
  })

  test("with no known secrets, a site is searched as before", () => {
    expect(found("smtp")).toEqual([])
    expect(found("cms")).toEqual(["cms"])
  })
})

describe("filtering", () => {
  test("several words must all match", () => {
    expect(found("cms restricted")).toEqual(["cms"])
    expect(found("restricted machine")).toEqual([])
  })

  test("the order of the words does not count", () => {
    expect(found("restricted cms")).toEqual(["cms"])
  })

  test("a query that is empty or made of spaces returns every site, in their order", () => {
    expect(filterSites(SITES, "")).toBe(SITES)
    expect(filterSites(SITES, "    ")).toBe(SITES)
  })

  test("the original order is kept", () => {
    expect(found("test-zone")).toEqual(["calendar", "cms", "dashboard", "builder", "wheels"])
  })

  test("no result returns an empty list", () => {
    expect(found("xyz")).toEqual([])
    expect(filterSites([], "cms")).toEqual([])
  })
})

describe("count and announcement", () => {
  test("the total alone with no filter and no search, the result over the total otherwise", () => {
    expect(countLabel(9, 9, false)).toBe("9 sites")
    expect(countLabel(1, 1, false)).toBe("1 site")
    expect(countLabel(3, 9, true)).toBe("3 of 9 sites")
    expect(countLabel(0, 9, true)).toBe("0 of 9 sites")
  })

  test("under Platform, the count names the platform's own projects", () => {
    expect(countLabel(3, 3, false, countNoun("platform"))).toBe("3 platform projects")
    expect(countLabel(1, 1, false, countNoun("platform"))).toBe("1 platform project")
    expect(countLabel(1, 3, true, countNoun("platform"))).toBe("1 of 3 platform projects")
    expect(countLabel(1, 1, false, countNoun("apps"))).toBe("1 site")
    expect(searchAnnouncement(3, 3, false, countNoun("platform"))).toBe("Showing all 3 platform projects")
    expect(searchAnnouncement(0, 3, true, countNoun("platform"))).toBe("No platform projects match")
    expect(searchAnnouncement(1, 3, true, countNoun("platform"))).toBe("1 platform project matches")
  })

  /** A fresh machine: the screen reads its empty state's title, and so does the announcement. */
  test("with no site listed outside Platform, the count says 0 and the announcement the empty state", () => {
    expect(countLabel(0, 0, true)).toBe("0 sites")
    expect(countLabel(0, 0, false)).toBe("0 sites")
    expect(searchAnnouncement(0, 0, false)).toBe("No sites deployed yet")
    expect(searchAnnouncement(0, 0, true)).toBe("No sites deployed yet")
    expect(searchAnnouncement(0, 0, true, countNoun("issues"))).toBe("No sites deployed yet")
  })

  test("the announcement is stated in the singular, the plural, or with no result", () => {
    expect(searchAnnouncement(3, 9, true)).toBe("3 sites match")
    expect(searchAnnouncement(1, 9, true)).toBe("1 site matches")
    expect(searchAnnouncement(0, 9, true)).toBe("No sites match")
    expect(searchAnnouncement(9, 9, false)).toBe("Showing all 9 sites")
  })
})

describe("the / shortcut", () => {
  const key = (partial: Partial<KeyPress> = {}): KeyPress => ({
    key: "/",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...partial,
  })
  const body = { tagName: "BODY", isContentEditable: false, closest: () => null }

  test("outside any field, / brings focus into the search", () => {
    expect(searchShortcut(key(), body)).toBe(true)
    expect(searchShortcut(key(), null)).toBe(true)
    expect(searchShortcut(key(), { tagName: "BUTTON", closest: () => null })).toBe(true)
  })

  test("another key does nothing", () => {
    expect(searchShortcut(key({ key: "?" }), body)).toBe(false)
    expect(searchShortcut(key({ key: "Slash" }), body)).toBe(false)
  })

  test("while typing, / gets written", () => {
    expect(searchShortcut(key(), { tagName: "INPUT", type: "text" })).toBe(false)
    expect(searchShortcut(key(), { tagName: "INPUT", type: "search" })).toBe(false)
    expect(searchShortcut(key(), { tagName: "INPUT", type: "password" })).toBe(false)
    expect(searchShortcut(key(), { tagName: "TEXTAREA" })).toBe(false)
    expect(searchShortcut(key(), { tagName: "SELECT" })).toBe(false)
    expect(searchShortcut(key(), { tagName: "DIV", isContentEditable: true })).toBe(false)
  })

  test("a field where nothing gets written lets the shortcut through", () => {
    expect(isTyping({ tagName: "INPUT", type: "checkbox" })).toBe(false)
    expect(isTyping({ tagName: "INPUT" })).toBe(true)
    expect(isTyping(null)).toBe(false)
  })

  test("Cmd and Ctrl belong to the browser, AltGr does not", () => {
    expect(searchShortcut(key({ metaKey: true }), body)).toBe(false)
    expect(searchShortcut(key({ ctrlKey: true }), body)).toBe(false)
    expect(searchShortcut(key({ ctrlKey: true, altKey: true }), body)).toBe(true)
  })

  test("neither during a composition, nor on a key already handled", () => {
    expect(searchShortcut(key({ isComposing: true }), body)).toBe(false)
    expect(searchShortcut(key({ defaultPrevented: true }), body)).toBe(false)
  })

  test("an open dialog keeps focus", () => {
    const button = { tagName: "BUTTON", closest: (selector: string) => (selector.includes("dialog") ? {} : null) }
    expect(searchShortcut(key(), button)).toBe(false)
  })
})
