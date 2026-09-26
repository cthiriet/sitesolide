import { describe, expect, test } from "bun:test"
import {
  MACHINE_PAGES,
  SECTIONS,
  ariaCurrent,
  plainClick,
  readAddress,
  pageFromUrl,
  redirect,
  requestedSite,
  pendingTitle,
  documentTitle,
  pageTitle,
  pageUrl,
  siteUrl,
  type Click,
  type Page,
} from "../src/lib/pages"
import { NO_DATA, verdict } from "../src/lib/verdict"
import { discrepancy } from "./factory"

describe("the page for an address", () => {
  test("the machine's pages are read from their path", () => {
    expect(pageFromUrl("/")).toEqual({ name: "home" })
    expect(pageFromUrl("/activity/")).toEqual({ name: "activity" })
  })

  test("every section of a site is read from its path and ?s=", () => {
    expect(pageFromUrl("/site/", "?s=cms")).toEqual({ name: "site", slug: "cms", section: "overview" })
    expect(pageFromUrl("/site/secrets/", "?s=cms")).toEqual({ name: "site", slug: "cms", section: "secrets" })
    expect(pageFromUrl("/site/guests/", "?s=cms")).toEqual({ name: "site", slug: "cms", section: "guests" })
    expect(pageFromUrl("/site/access/", "?s=test-zone.invalid")).toEqual({
      name: "site",
      slug: "test-zone.invalid",
      section: "access",
    })
  })

  /** file_server serves the same file under these three forms, and `/site` redirects to `/site/`. */
  test("with no trailing slash, or by the file name, it is the same page", () => {
    expect(pageFromUrl("/site", "?s=cms")).toEqual({ name: "site", slug: "cms", section: "overview" })
    expect(pageFromUrl("/site/secrets/index.html", "?s=cms")).toEqual({
      name: "site",
      slug: "cms",
      section: "secrets",
    })
    expect(pageFromUrl("/index.html")).toEqual({ name: "home" })
    expect(pageFromUrl("//activity//")).toEqual({ name: "activity" })
  })

  test("an unknown path counts as the home page", () => {
    expect(pageFromUrl("/unknown/")).toEqual({ name: "home" })
    expect(pageFromUrl("/site/cms/")).toEqual({ name: "home" })
    expect(pageFromUrl("/Site/", "?s=cms")).toEqual({ name: "home" })
    expect(pageFromUrl("")).toEqual({ name: "home" })
  })

  test("a section with no site, or with an empty site, counts as the home page", () => {
    expect(pageFromUrl("/site/")).toEqual({ name: "home" })
    expect(pageFromUrl("/site/secrets/", "?s=")).toEqual({ name: "home" })
    expect(pageFromUrl("/site/guests/", "?s=%20%20")).toEqual({ name: "home" })
    expect(pageFromUrl("/site/access/", "?site=cms")).toEqual({ name: "home" })
  })

  test("the slug is decoded, and the first ?s= wins", () => {
    expect(pageFromUrl("/site/", "?s=a%20b")).toEqual({ name: "site", slug: "a b", section: "overview" })
    expect(pageFromUrl("/site/", "?s=a&s=b")).toEqual({ name: "site", slug: "a", section: "overview" })
  })

  test("?s= only counts inside a site section", () => {
    expect(pageFromUrl("/", "?s=cms")).toEqual({ name: "home" })
    expect(pageFromUrl("/activity/", "?s=cms")).toEqual({ name: "activity" })
  })
})

describe("older addresses", () => {
  test("they are read like their equivalent", () => {
    expect(pageFromUrl("/sites/")).toEqual({ name: "home" })
    expect(pageFromUrl("/sites/", "?site=cms")).toEqual({ name: "site", slug: "cms", section: "overview" })
    expect(pageFromUrl("/sites", "?site=cms")).toEqual({ name: "site", slug: "cms", section: "overview" })
    expect(pageFromUrl("/secrets/")).toEqual({ name: "home" })
    expect(pageFromUrl("/secrets/", "?site=cms")).toEqual({ name: "site", slug: "cms", section: "secrets" })
    expect(pageFromUrl("/guests/")).toEqual({ name: "home" })
    expect(pageFromUrl("/guests/", "?site=cms")).toEqual({ name: "home" })
  })

  test("they redirect to the new address", () => {
    expect(redirect("/sites/")).toBe("/")
    expect(redirect("/sites/", "?site=cms")).toBe("/site/?s=cms")
    expect(redirect("/sites/index.html", "?site=cms")).toBe("/site/?s=cms")
    expect(redirect("/secrets/")).toBe("/")
    expect(redirect("/secrets/", "?site=cms")).toBe("/site/secrets/?s=cms")
    expect(redirect("/secrets/", "?site=")).toBe("/")
    expect(redirect("/guests/")).toBe("/")
  })

  test("the old slug is re-encoded, tricky ones included", () => {
    expect(redirect("/sites/", "?site=a%26s%3Db")).toBe("/site/?s=a%26s%3Db")
    expect(
      pageFromUrl("/site/", new URL(redirect("/sites/", "?site=a%26s%3Db") ?? "", "http://x").search),
    ).toEqual({
      name: "site",
      slug: "a&s=b",
      section: "overview",
    })
  })

  test("a section with no site redirects to the home page", () => {
    expect(redirect("/site/")).toBe("/")
    expect(redirect("/site/secrets/", "?s=")).toBe("/")
  })

  test("a new address does not redirect, unknown parameters included", () => {
    expect(redirect("/")).toBeNull()
    expect(redirect("/", "?q=cms")).toBeNull()
    expect(redirect("/activity/")).toBeNull()
    expect(redirect("/site/", "?s=cms")).toBeNull()
    expect(redirect("/site/access/", "?s=cms&view=1")).toBeNull()
    expect(redirect("/unknown/")).toBeNull()
  })
})

describe("the address parameters", () => {
  const params = (search: string) => new URLSearchParams(search)

  test("the site asked for is read decoded, the first one wins", () => {
    expect(requestedSite(params("?s=cms"))).toBe("cms")
    expect(requestedSite(params("?s=a%20b%26c"))).toBe("a b&c")
    expect(requestedSite(params("?s=a&s=b"))).toBe("a")
    expect(requestedSite(params("?site=cms"), "site")).toBe("cms")
  })

  test("empty, made of spaces or absent, it asks for nothing", () => {
    expect(requestedSite(params(""))).toBeNull()
    expect(requestedSite(params("?s="))).toBeNull()
    expect(requestedSite(params("?s=%20"))).toBeNull()
    expect(requestedSite(params("?site=cms"))).toBeNull()
  })

  test("an address gives its page and its parameters, together, without the fragment", () => {
    const unitEnv = readAddress("/site/secrets/?s=cms&view=1#file")
    expect(unitEnv.page).toEqual({ name: "site", slug: "cms", section: "secrets" })
    expect(unitEnv.params.get("view")).toBe("1")
    expect(unitEnv.params.has("file")).toBe(false)
  })
})

describe("the address of a page", () => {
  test("always with the trailing slash, which avoids file_server's redirect", () => {
    for (const entry of MACHINE_PAGES) expect(pageUrl({ name: entry.name })).toEndWith("/")
    for (const entry of SECTIONS) expect(new URL(siteUrl("cms", entry.section), "http://x").pathname).toEndWith("/")
  })

  test("a site encodes its slug, and Overview is the default section", () => {
    expect(siteUrl("cms")).toBe("/site/?s=cms")
    expect(siteUrl("cms", "guests")).toBe("/site/guests/?s=cms")
    expect(siteUrl("a&s=c")).toBe("/site/?s=a%26s%3Dc")
  })

  test("the round trip returns the same page, for every page and for tricky slugs", () => {
    const pages: Page[] = [
      ...MACHINE_PAGES.map((entry): Page => ({ name: entry.name })),
      ...SECTIONS.map((entry): Page => ({ name: "site", slug: "cms", section: entry.section })),
      { name: "site", slug: "test-zone.invalid", section: "secrets" },
      { name: "site", slug: "a&s=b", section: "access" },
      { name: "site", slug: "../secrets/", section: "overview" },
      { name: "site", slug: "é ?#", section: "guests" },
    ]
    for (const page of pages) {
      const url = new URL(pageUrl(page), "http://page.invalid")
      expect(pageFromUrl(url.pathname, url.search)).toEqual(page)
      expect(redirect(url.pathname, url.search)).toBeNull()
    }
  })

  test("every built file has a page, older addresses included", async () => {
    const root = new URL("../src/pages/", import.meta.url)
    const glob = new Bun.Glob("**/index.astro")
    const paths = [...glob.scanSync(root.pathname)].map((file) => `/${file.replace(/index\.astro$/, "")}`)
    const expected = [
      ...MACHINE_PAGES.map((entry) => entry.path),
      ...SECTIONS.map((entry) => entry.path),
      "/sites/",
      "/secrets/",
      "/guests/",
    ]
    expect(paths.sort()).toEqual(expected.sort())
  })
})

describe("current entry", () => {
  test("only the page itself is current", () => {
    const cms: Page = { name: "site", slug: "cms", section: "secrets" }
    expect(ariaCurrent(cms, { name: "site", slug: "cms", section: "secrets" })).toBe("page")
    expect(ariaCurrent(cms, { name: "site", slug: "cms", section: "overview" })).toBeUndefined()
    expect(ariaCurrent(cms, { name: "site", slug: "calendar", section: "secrets" })).toBeUndefined()
    expect(ariaCurrent({ name: "home" }, { name: "home" })).toBe("page")
    expect(ariaCurrent(cms, { name: "home" })).toBeUndefined()
  })
})

describe("titles", () => {
  test("the page's name, the slug for a site's Overview, the section otherwise", () => {
    expect(pageTitle({ name: "home" })).toBe("Sites")
    expect(pageTitle({ name: "activity" })).toBe("Activity")
    expect(pageTitle({ name: "site", slug: "cms", section: "overview" })).toBe("cms")
    expect(pageTitle({ name: "site", slug: "cms", section: "access" })).toBe("Access")
  })

  test("the tab keeps quiet on the home page when all is well, and a section names its site", () => {
    const ok = verdict([], false)
    expect(documentTitle({ name: "home" }, ok)).toBe("sitesolide")
    expect(documentTitle({ name: "home" }, null)).toBe("sitesolide")
    expect(documentTitle({ name: "activity" }, ok)).toBe("Activity · sitesolide")
    expect(documentTitle({ name: "site", slug: "cms", section: "overview" }, null)).toBe("cms · sitesolide")
    expect(documentTitle({ name: "site", slug: "cms", section: "secrets" }, ok)).toBe("Secrets · cms · sitesolide")
  })

  test("the verdict comes first when it is not good", () => {
    const bad = verdict([discrepancy("error"), discrepancy("warning")], false)
    expect(documentTitle({ name: "home" }, bad)).toBe("1 error · 1 warning · sitesolide")
    expect(documentTitle({ name: "site", slug: "cms", section: "guests" }, bad)).toBe(
      "1 error · 1 warning · Guests · cms · sitesolide",
    )
    expect(documentTitle({ name: "activity" }, NO_DATA)).toBe("No data · Activity · sitesolide")
    expect(documentTitle({ name: "home" }, verdict([], true))).toBe("Stale data · sitesolide")
  })

  test("during the check, a site file has no title yet", () => {
    expect(pendingTitle("/")).toBe("Sites")
    expect(pendingTitle("/activity/")).toBe("Activity")
    expect(pendingTitle("/site/")).toBeNull()
    expect(pendingTitle("/site/secrets/")).toBeNull()
    expect(pendingTitle("/sites/")).toBe("Sites")
  })
})

describe("click on an internal link", () => {
  const click = (partial: Partial<Click> = {}): Click => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...partial,
  })

  test("a plain click stays inside the page", () => {
    expect(plainClick(click())).toBe(true)
    expect(plainClick(click(), "_self")).toBe(true)
    expect(plainClick(click(), "")).toBe(true)
  })

  test("new tab, new window, download: the browser decides", () => {
    expect(plainClick(click({ metaKey: true }))).toBe(false)
    expect(plainClick(click({ ctrlKey: true }))).toBe(false)
    expect(plainClick(click({ shiftKey: true }))).toBe(false)
    expect(plainClick(click({ altKey: true }))).toBe(false)
  })

  test("the middle click, another target, a click already handled: nothing", () => {
    expect(plainClick(click({ button: 1 }))).toBe(false)
    expect(plainClick(click(), "_blank")).toBe(false)
    expect(plainClick(click({ defaultPrevented: true }))).toBe(false)
  })
})
