/**
 * What the dashboard's icons mean, in words. Pure, tested by
 * tests/legend.test.ts; components/legend.tsx draws them.
 *
 * Each icon means one thing everywhere: in a row, in its tooltip, in the
 * facet menu that is its legend, in a sheet. Two families: a project's kind,
 * what it is from the outside, and its general access, how a visitor gets
 * in. The words are the Access section's and the vocabulary's (web/DESIGN.md
 * section 6), never new ones.
 */
import { GENERAL_CHOICES } from "./access"
import { isAnchoredSite, type Access } from "./sites"
import type { Site } from "./types"

// --- Kind --------------------------------------------------------------------------

/**
 * What a project is from the outside: a static site, an app that serves
 * pages, a project that serves no page and runs for good, one whose every
 * service runs on a schedule, or a folder with no manifest.
 */
export type Kind = "static" | "app" | "background" | "scheduled" | "none"

/** The order of the Kind facet. */
export const KINDS: readonly Kind[] = ["static", "app", "background", "scheduled", "none"]

export type KindWords = {
  /** The project's kind as a noun, in a sheet or a tooltip's first line: "Static site". */
  label: string
  /** The facet's item, which names a set: "Apps". */
  facet: string
  /** One sentence, the tooltip's second line. */
  description: string
}

export const KIND_WORDS: Readonly<Record<Kind, KindWords>> = {
  static: { label: "Static site", facet: "Static", description: "Serves its files, with no service running." },
  app: { label: "App", facet: "Apps", description: "Serves pages through a service." },
  background: { label: "Background", facet: "Background", description: "Runs in the background, serves no page." },
  scheduled: { label: "Scheduled", facet: "Scheduled", description: "Runs on a schedule, serves no page." },
  none: { label: "No manifest", facet: "No manifest", description: "Its folder has no sitesolide.json." },
}

/**
 * A project's kind. An app that serves no page is Background, unless every
 * one of its services is scheduled, its main unit then an anchor that runs
 * nothing (`isAnchoredSite`).
 */
export function siteKind(site: Pick<Site, "type" | "headless" | "services">): Kind {
  if (site.type === "static") return "static"
  if (site.type === "no-manifest") return "none"
  if (!site.headless) return "app"
  return isAnchoredSite(site) ? "scheduled" : "background"
}

// --- General access ------------------------------------------------------------------

/** How a visitor gets in, as an icon: the three ways, and the disagreement that leaves a site open. */
export type AccessKey = "public" | "restricted" | "code" | "mismatch"

/** The order of the Access facet. */
export const ACCESS_KEYS: readonly AccessKey[] = ["public", "restricted", "code", "mismatch"]

export type AccessWords = { label: string; facet: string; description: string }

const sentence = (access: "public" | "restricted" | "code") => GENERAL_CHOICES.find((choice) => choice.access === access)!.sentence

export const ACCESS_WORDS: Readonly<Record<AccessKey, AccessWords>> = {
  public: { label: "Public", facet: "Public", description: sentence("public") },
  restricted: { label: "Restricted", facet: "Restricted", description: sentence("restricted") },
  code: { label: "Anyone with the code", facet: "Anyone with the code", description: sentence("code") },
  mismatch: {
    label: "Access mismatch",
    facet: "Mismatch",
    description: "sitesolide.json and the server disagree on how it opens. Choose one in its Access section.",
  },
}

/** The icon a site's general access takes, from `siteAccess`. */
export function accessKey(access: Access): AccessKey {
  switch (access.kind) {
    case "open":
      return "public"
    case "portal":
      return "restricted"
    case "code":
      return "code"
    case "mismatch":
      return "mismatch"
  }
}

/** What the paths left open read as, the Access section's own words. */
export const EXEMPT_LINE = "Open to anyone, guarded by the app alone"

/**
 * The lines of an access icon's tooltip, in the Access section's words: the
 * way it opens, then what that way leaves out of sight in a row, the exempt
 * paths of a restricted site, the code of one that opens with it, or both
 * sides of a disagreement.
 */
export function accessLines(access: Access, slug?: string): string[] {
  switch (access.kind) {
    case "open":
      return ["Public", ACCESS_WORDS.public.description]
    case "portal":
      return access.exemptions.length === 0
        ? ["Restricted", ACCESS_WORDS.restricted.description]
        : ["Restricted", ACCESS_WORDS.restricted.description, `${EXEMPT_LINE}: ${access.exemptions.join(", ")}`]
    case "code":
      return access.code === null
        ? ["Anyone with the code", slug === undefined ? "An Admin, or the owner, has the code." : `An Admin of ${slug}, or the owner, has the code.`]
        : ["Anyone with the code", `Code: ${access.code}`]
    case "mismatch":
      return ["Access mismatch", access.label]
  }
}
