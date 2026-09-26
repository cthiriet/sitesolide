/**
 * The dashboard's pages and their addresses. Pure: this module reads neither
 * `window.location` nor the history, it turns an address into a page and a page
 * into an address, and the navigation component uses it both ways.
 *
 * Two levels. The machine's: the home page, where the machine, its
 * discrepancies and the list of sites live, and the steward's activity. A
 * site's: five sections, Overview, Audience, Secrets, Guests and Access, the
 * site as a parameter.
 *
 * Every page is a file of the build, `site/secrets/index.html` for
 * `/site/secrets/`: Caddy serves `public/` through `file_server`, with no
 * rewrite, and a reload or a direct link has to land on a real file. The site
 * has no file of its own: it lives under `?s=`, and one more site does not
 * require rebuilding the page.
 *
 * Addresses are written with the trailing slash. `file_server` redirects
 * `/site` to `/site/`, and a link without it would cost a round trip.
 *
 * The addresses from before the per-site page, `/sites/`, `/secrets/` and
 * `/guests/`, keep their file so bookmarks keep working: they are read like
 * their equivalent, and navigation replaces the address with the new one.
 */
import type { Verdict } from "./verdict"

/** A site's sections, in the order of the sidebar and the tabs. */
export type Section = "overview" | "audience" | "secrets" | "guests" | "access"

/** The pages of the machine level. */
export type MachinePage = "home" | "activity"

export type Page = { name: MachinePage } | { name: "site"; slug: string; section: Section }

export type MachineEntry = { name: MachinePage; title: string; path: string }
export type SectionEntry = { section: Section; title: string; path: string }

/** The order of the sidebar and the tabs, at the machine level. */
export const MACHINE_PAGES: readonly MachineEntry[] = [
  { name: "home", title: "Sites", path: "/" },
  { name: "activity", title: "Activity", path: "/activity/" },
]

/** The order of the sidebar and the tabs, inside a site. */
export const SECTIONS: readonly SectionEntry[] = [
  { section: "overview", title: "Overview", path: "/site/" },
  { section: "audience", title: "Audience", path: "/site/audience/" },
  { section: "secrets", title: "Secrets", path: "/site/secrets/" },
  { section: "guests", title: "Guests", path: "/site/guests/" },
  { section: "access", title: "Access", path: "/site/access/" },
]

/** The parameter that names the site: `/site/secrets/?s=cms`. */
export const SITE_PARAM = "s"

/** The parameter of the older addresses, `/sites/?site=cms` and `/secrets/?site=cms`. */
export const LEGACY_PARAM = "site"

/** The query parameters, read only: a page reads them, only navigation changes them. */
export type SearchParams = Pick<URLSearchParams, "get" | "getAll" | "has">

/** The page title's id, where focus returns after a navigation. */
export const PAGE_TITLE_ID = "title-page"

/** The older addresses, and the section they open when they name a site. */
const LEGACY_PATHS: Readonly<Record<string, Section | null>> = {
  "/sites/": "overview",
  "/secrets/": "secrets",
  "/guests/": null,
}

/**
 * The path without `index.html` and with its trailing slash: `/site`, `/site/`
 * and `/site/index.html` all name the same file.
 */
export function normalizePath(path: string): string {
  let clean = path.replace(/\/index\.html$/, "/")
  if (!clean.startsWith("/")) clean = `/${clean}`
  if (!clean.endsWith("/")) clean = `${clean}/`
  return clean.replace(/\/{2,}/g, "/")
}

/**
 * The site a parameter asks for, decoded, or null. The first one wins; empty or
 * made of spaces, it asks for nothing.
 */
export function requestedSite(params: SearchParams, name: string = SITE_PARAM): string | null {
  const slug = params.get(name)
  return slug === null || slug.trim() === "" ? null : slug
}

/**
 * The page for an address. An unknown path counts as the home page: Caddy only
 * serves the built files anyway, and the island must never be left without a
 * page. A section with no site, or an older address with no site, also counts
 * as the home page: there is nothing else to show.
 */
export function pageFromUrl(path: string, search = ""): Page {
  const normalized = normalizePath(path)
  const params = new URLSearchParams(search)

  const section = SECTIONS.find((candidate) => candidate.path === normalized)
  if (section !== undefined) {
    const slug = requestedSite(params)
    return slug === null ? { name: "home" } : { name: "site", slug, section: section.section }
  }

  if (Object.hasOwn(LEGACY_PATHS, normalized)) {
    const legacySection = LEGACY_PATHS[normalized] ?? null
    const slug = requestedSite(params, LEGACY_PARAM)
    return legacySection === null || slug === null ? { name: "home" } : { name: "site", slug, section: legacySection }
  }

  const machine = MACHINE_PAGES.find((candidate) => candidate.path === normalized)
  return { name: machine?.name ?? "home" }
}

/**
 * The address that should replace this one, or null if it is fine. An older
 * address goes to its equivalent, a section with no site goes to the home page.
 * The rest stay as they are, unknown parameters included: nothing is lost on an
 * address that is already the new one.
 */
export function redirect(path: string, search = ""): string | null {
  const normalized = normalizePath(path)
  const legacy = Object.hasOwn(LEGACY_PATHS, normalized)
  const sectionSansSite =
    SECTIONS.some((candidate) => candidate.path === normalized) && requestedSite(new URLSearchParams(search)) === null
  if (!legacy && !sectionSansSite) return null
  return pageUrl(pageFromUrl(path, search))
}

/**
 * What the island reads of the browser's address, path and query: the page, and
 * the parameters the page reads in turn, such as the home page's search. Both
 * come from the same address, so that the page never reads `window.location`
 * itself during a render.
 */
export function readAddress(address: string): { page: Page; params: SearchParams } {
  const url = new URL(address, "http://page.invalid")
  return { page: pageFromUrl(url.pathname, url.search), params: url.searchParams }
}

function sectionEntry(section: Section): SectionEntry {
  // SECTIONS covers every Section: the fallback is only there for typing.
  return SECTIONS.find((candidate) => candidate.section === section) ?? { section: "overview", title: "Overview", path: "/site/" }
}

function machineEntry(name: MachinePage): MachineEntry {
  return MACHINE_PAGES.find((candidate) => candidate.name === name) ?? { name: "home", title: "Sites", path: "/" }
}

/** The address of a site's section, to share or to open in a new tab. */
export function siteUrl(slug: string, section: Section = "overview"): string {
  return `${sectionEntry(section).path}?${SITE_PARAM}=${encodeURIComponent(slug)}`
}

export function pageUrl(page: Page): string {
  return page.name === "site" ? siteUrl(page.slug, page.section) : machineEntry(page.name).path
}

/** What the sidebar says of an entry: the page itself, or nothing. */
export function ariaCurrent(page: Page, target: Page): "page" | undefined {
  return pageUrl(page) === pageUrl(target) ? "page" : undefined
}

/** The page title: the page's name, the slug for a site's Overview, the section's name otherwise. */
export function pageTitle(page: Page): string {
  if (page.name !== "site") return machineEntry(page.name).title
  return page.section === "overview" ? page.slug : sectionEntry(page.section).title
}

/**
 * The tab title. The verdict comes first when it is not good: a narrow tab only
 * shows the beginning, and that is the part that counts. The home page keeps
 * quiet when all is well; a section names its site after it.
 */
export function documentTitle(page: Page, verdict: Verdict | null): string {
  const parts: string[] = []
  if (page.name === "activity") parts.push(pageTitle(page))
  if (page.name === "site") {
    if (page.section !== "overview") parts.push(sectionEntry(page.section).title)
    parts.push(page.slug)
  }
  if (verdict !== null && verdict.tone !== "ok") parts.unshift(verdict.label)
  return [...parts, "sitesolide"].join(" · ")
}

/**
 * The title to show while the session is being checked, from the served file
 * alone: the build does not know which site is being asked for, and a site
 * title is then replaced by a skeleton.
 */
export function pendingTitle(path: string): string | null {
  const normalized = normalizePath(path)
  if (SECTIONS.some((candidate) => candidate.path === normalized)) return null
  return pageTitle(pageFromUrl(path))
}

export type Click = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * True if a click on an internal link should stay inside the page. The middle
 * click, Cmd or Ctrl (new tab), Shift (new window), Alt (download) and a target
 * other than the page belong to the browser.
 */
export function plainClick(click: Click, target: string | null = null): boolean {
  if (click.defaultPrevented || click.button !== 0) return false
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false
  return target === null || target === "" || target === "_self"
}
