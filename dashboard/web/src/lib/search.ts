/**
 * The site search: what it reads of a site, how it compares, what it announces,
 * and when the `/` shortcut should focus it. Pure, and therefore testable
 * without a browser.
 *
 * It covers what the row displays, labels included, computed by the same
 * functions as the row: a word read on screen always finds its site again, even
 * the day a label changes.
 */
import { PENDING_LABEL, type SiteSecretsPanel } from "./secrets"
import { TYPE_LABELS, siteAccess, siteAddress, serviceState } from "./sites"
import type { Site } from "./types"

/**
 * The secrets come from the shared read, when it has succeeded: optional, so
 * that a site can be searched without them too.
 */
export type SearchableSite = Pick<
  Site,
  "slug" | "description" | "type" | "port" | "address" | "domain" | "portal" | "lock" | "service"
> &
  Partial<SiteSecretsPanel>

/**
 * Lowercase and unaccented: an accented description is found again by typing
 * without accents, in capitals, and the other way round. The compatibility
 * decomposition separates the letter from its accent, which is then removed;
 * the French ligatures, which do not decompose, are written as two letters.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
}

/** An address pasted from the browser bar: only the host is shown in the table. */
const HOST_URL = /^https?:\/\/([^/\s]+)\/?$/

/**
 * A query's words, normalised. A query that is empty or made of spaces has
 * none, and therefore filters nothing.
 */
export function queryWords(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((word) => HOST_URL.exec(word)?.[1] ?? word)
    .filter((word) => word !== "")
}

/** What the Access column shows, spelled out, including what a screen reader reads. */
export function accessTexts(site: Pick<Site, "portal" | "lock">): string[] {
  const access = siteAccess(site)
  switch (access.kind) {
    case "code":
      return ["Preview lock", access.code]
    case "portal":
      return ["Portal", ...access.exemptions]
    case "open":
      return ["No gate"]
    case "mismatch":
      return [access.label]
  }
}

/**
 * The texts of a site the search covers: slug, description, type (the filters'
 * word), port, addresses and their note, domain aliases, access, service state,
 * the names of its secret variables and the restart pending pill. The aliases
 * are not displayed, but a client gives them as readily as their domain; the
 * variables show in the site's Secrets and Overview, and a key is looked up
 * more often by its name than by the site that reads it.
 */
export function siteTexts(site: SearchableSite): string[] {
  const address = siteAddress(site)
  return [
    site.slug,
    site.description ?? "",
    TYPE_LABELS[site.type],
    site.port === null ? "" : `:${site.port}`,
    address.text,
    address.note?.text ?? "",
    site.address,
    ...(site.domain === null ? [] : [site.domain.name, ...site.domain.aliases]),
    ...accessTexts(site),
    serviceState(site).label,
    ...(site.variables ?? []),
    site.restartPending === true ? PENDING_LABEL : "",
  ].filter((text) => text !== "")
}

/**
 * A site's normalised text. The fields are separated by a line break: a query
 * word never contains a space, so it cannot match across two fields.
 */
export function siteFingerprint(site: SearchableSite): string {
  return normalize(siteTexts(site).join("\n"))
}

/** Every word has to be found in the site, in any field and at any position. */
export function correspond(site: SearchableSite, words: string[]): boolean {
  const hash = siteFingerprint(site)
  return words.every((word) => hash.includes(word))
}

/** The sites that match, in their original order. With no word, all of them. */
export function filterSites<T extends SearchableSite>(sites: T[], query: string): T[] {
  const words = queryWords(query)
  if (words.length === 0) return sites
  return sites.filter((site) => correspond(site, words))
}

/** The toolbar's count: "13 sites", or "3 of 13 sites" under a filter or a search. */
export function countLabel(visible: number, total: number, narrowed: boolean): string {
  const word = total === 1 ? "site" : "sites"
  return narrowed ? `${visible} of ${total} ${word}` : `${total} ${word}`
}

/** What the `aria-live` region says once typing settles, or the filter changes. */
export function searchAnnouncement(visible: number, total: number, narrowed: boolean): string {
  if (!narrowed) return `Showing all ${total} sites`
  if (visible === 0) return "No sites match"
  return visible === 1 ? "1 site matches" : `${visible} sites match`
}

export type KeyPress = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  defaultPrevented: boolean
}

export type Target = {
  tagName: string
  isContentEditable?: boolean
  type?: string
  closest?: (selector: string) => unknown
}

/** The `input` fields where a keystroke writes nothing: `/` stays a shortcut there. */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"])

/** True if focus is somewhere `/` gets typed. */
export function isTyping(target: Target | null): boolean {
  if (target === null) return false
  if (target.isContentEditable === true) return true
  const tag = target.tagName.toUpperCase()
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase())
  return false
}

/**
 * True if `/` should move focus into the search. Never during typing, during a
 * composition (accents, IME), or inside a dialog that traps focus. Cmd and Ctrl
 * belong to the browser; Ctrl and Alt together are AltGr on Windows, through
 * which some layouts type `/`.
 */
export function searchShortcut(key: KeyPress, target: Target | null): boolean {
  if (key.key !== "/" || key.isComposing || key.defaultPrevented) return false
  if (key.metaKey || (key.ctrlKey && !key.altKey)) return false
  if (isTyping(target)) return false
  return !target?.closest?.('[role="dialog"], [role="alertdialog"]')
}
