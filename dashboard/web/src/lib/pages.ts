/**
 * The dashboard's pages and their addresses. Pure: this module reads neither
 * `window.location` nor the history, it turns an address into a page and a page
 * into an address, and the navigation component uses it both ways.
 *
 * Two levels. The machine's: the home page, where the machine, its
 * discrepancies and the list of sites live, the machine's audit, the People
 * with a role somewhere, the Tokens that deploy without SSH, and the
 * connectors the egress proxy lends. A site's: five sections, Overview,
 * Audience, Secrets, Access and Backups, the site as a parameter.
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
 * Older addresses keep their file so bookmarks keep working: `/sites/`,
 * `/secrets/` and `/guests/` from before the per-site page, `/team/` and
 * `/members/` from before Tokens and People, and a site's Guests, Sharing and
 * Members from before its one Access section. They are read like their
 * equivalent, and navigation replaces the address with the new one.
 */
import type { IdentityView, Role } from "./types"
import type { Verdict } from "./verdict"

/** A site's sections, in the order of the sidebar and the tabs. */
export type Section = "overview" | "audience" | "secrets" | "access" | "backups"

/** The pages of the machine level. */
export type MachinePage = "home" | "activity" | "people" | "tokens" | "connectors"

export type Page = { name: MachinePage } | { name: "site"; slug: string; section: Section }

export type MachineEntry = { name: MachinePage; title: string; path: string }
export type SectionEntry = { section: Section; title: string; path: string }

/** The order of the sidebar and the tabs, at the machine level. */
export const MACHINE_PAGES: readonly MachineEntry[] = [
  { name: "home", title: "Sites", path: "/" },
  { name: "activity", title: "Activity", path: "/activity/" },
  { name: "people", title: "People", path: "/people/" },
  { name: "tokens", title: "Tokens", path: "/tokens/" },
  { name: "connectors", title: "Connectors", path: "/connectors/" },
]

/**
 * What a person signed in with their company account sees: their projects on
 * the home page, the activity of their projects, Tokens for their own tokens
 * when a role or the create right lets them mint one, and in a site the
 * sections their role there opens, the steward's own table
 * (src/people/powers.ts): a Viewer its Overview, Audience and Access, read
 * only; a Developer its Secrets too, values write-only; an Admin everything
 * of the site. The rest is the owner's, hidden here and refused by the
 * service.
 */
const PERSON_PAGES: readonly MachinePage[] = ["home", "activity"]

/** May this person mint a token of their own: a Developer or an Admin somewhere, or the create right. A Viewer mints nothing. */
export function mayMint(identity: Extract<IdentityView, { kind: "person" }>): boolean {
  return identity.create || Object.values(identity.roles).some((role) => role === "developer" || role === "admin")
}

function personPages(identity: Extract<IdentityView, { kind: "person" }>): readonly MachinePage[] {
  return mayMint(identity) ? [...PERSON_PAGES, "tokens"] : PERSON_PAGES
}

const ROLE_SECTIONS: Readonly<Record<Role, readonly Section[]>> = {
  viewer: ["overview", "audience", "access"],
  developer: ["overview", "audience", "secrets", "access"],
  admin: ["overview", "audience", "secrets", "access", "backups"],
}

const OWNER_SECTIONS: readonly Section[] = ["overview", "audience", "secrets", "access", "backups"]

function isPersonIdentity(identity: IdentityView | null): identity is Extract<IdentityView, { kind: "person" }> {
  return identity !== null && identity.kind === "person"
}

/** The person's role on a project, null when they hold none or are the owner. */
export function roleIn(identity: IdentityView | null, slug: string): Role | null {
  if (!isPersonIdentity(identity)) return null
  return Object.hasOwn(identity.roles, slug) ? identity.roles[slug]! : null
}

/** The machine's pages this person may open, in the sidebar's order. */
export function machinePagesFor(identity: IdentityView | null): readonly MachineEntry[] {
  if (!isPersonIdentity(identity)) return MACHINE_PAGES
  const pages = personPages(identity)
  return MACHINE_PAGES.filter((entry) => pages.includes(entry.name))
}

function allowedSections(identity: IdentityView | null, slug: string): readonly Section[] {
  if (!isPersonIdentity(identity)) return OWNER_SECTIONS
  const role = roleIn(identity, slug)
  return role === null ? ROLE_SECTIONS.viewer : ROLE_SECTIONS[role]
}

/** A site's sections this person may open, in the sidebar's order. */
export function sectionsFor(identity: IdentityView | null, slug: string): readonly SectionEntry[] {
  const allowed = allowedSections(identity, slug)
  return SECTIONS.filter((entry) => allowed.includes(entry.section))
}

/** May this person open this page? A person asking for one that is not theirs is told so. */
export function mayOpen(page: Page, identity: IdentityView | null): boolean {
  if (page.name === "site") return allowedSections(identity, page.slug).includes(page.section)
  return !isPersonIdentity(identity) || personPages(identity).includes(page.name)
}

/** The order of the sidebar and the tabs, inside a site. */
export const SECTIONS: readonly SectionEntry[] = [
  { section: "overview", title: "Overview", path: "/site/" },
  { section: "audience", title: "Audience", path: "/site/audience/" },
  { section: "secrets", title: "Secrets", path: "/site/secrets/" },
  { section: "access", title: "Access", path: "/site/access/" },
  { section: "backups", title: "Backups", path: "/site/backups/" },
]

/** The parameter that names the site: `/site/secrets/?s=cms`. */
export const SITE_PARAM = "s"

/** The parameter of the older addresses, `/sites/?site=cms` and `/secrets/?site=cms`. */
export const LEGACY_PARAM = "site"

/** The query parameters, read only: a page reads them, only navigation changes them. */
export type SearchParams = Pick<URLSearchParams, "get" | "getAll" | "has">

/** The page title's id, where focus returns after a navigation. */
export const PAGE_TITLE_ID = "title-page"

/**
 * An older address: a machine page it now names, or a site's section and the
 * parameter that carried the site there (null: no section, the home page).
 */
type Legacy = { kind: "machine"; page: MachinePage } | { kind: "section"; section: Section | null; param: string }

/** The older addresses, and what they open now. */
export const LEGACY_PATHS: Readonly<Record<string, Legacy>> = {
  "/sites/": { kind: "section", section: "overview", param: LEGACY_PARAM },
  "/secrets/": { kind: "section", section: "secrets", param: LEGACY_PARAM },
  "/guests/": { kind: "section", section: null, param: LEGACY_PARAM },
  "/team/": { kind: "machine", page: "tokens" },
  "/members/": { kind: "machine", page: "people" },
  "/site/guests/": { kind: "section", section: "access", param: SITE_PARAM },
  "/site/sharing/": { kind: "section", section: "access", param: SITE_PARAM },
  "/site/members/": { kind: "section", section: "access", param: SITE_PARAM },
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
    const legacy = LEGACY_PATHS[normalized]!
    if (legacy.kind === "machine") return { name: legacy.page }
    const slug = requestedSite(params, legacy.param)
    return legacy.section === null || slug === null ? { name: "home" } : { name: "site", slug, section: legacy.section }
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
  const sectionWithoutSite =
    SECTIONS.some((candidate) => candidate.path === normalized) && requestedSite(new URLSearchParams(search)) === null
  if (!legacy && !sectionWithoutSite) return null
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
  if (page.name !== "home" && page.name !== "site") parts.push(pageTitle(page))
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
  const legacy = Object.hasOwn(LEGACY_PATHS, normalized) ? LEGACY_PATHS[normalized]! : null
  // A site's older section, which carries its site the way the new ones do.
  if (legacy !== null && legacy.kind === "section" && legacy.param === SITE_PARAM) return null
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
