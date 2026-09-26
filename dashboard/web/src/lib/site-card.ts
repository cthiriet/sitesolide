/**
 * What a site's card composes from the snapshot: its discrepancies, its state
 * in one sentence, its service, its addresses, its door and its storage. Pure,
 * and therefore testable without a browser.
 *
 * Nothing is judged anew here. The discrepancies come from `src/state.ts`,
 * which decides what is wrong; the memory thresholds from lib/gauges.ts, which
 * takes its own from there; the card only arranges and names.
 */
import { ABSENT, dateTime, duration, ago, size } from "./format"
import { serviceLevel, MEMORY_CRITICAL_SHARE, PEAK_WARNING_SHARE, type Tile } from "./gauges"
import { siteAccess, serviceState, computeCpuShare, memoryShare, type Access, type Mismatch, type ServiceState } from "./sites"
import type { Tone } from "./tones"
import type { Discrepancy, Site } from "./types"
import { countBySeverity, sortDiscrepancies } from "./verdict"

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** A fact on the card: a label, its value, a clarification, and the value's tone. */
export type Fact = { label: string; value: string; detail: string | null; tone: Tone }

const fact = (label: string, value: string, detail: string | null = null, tone: Tone = "neutral"): Fact => ({
  label,
  value,
  detail,
  tone,
})

// --- The discrepancies and the state ---------------------------------------------

/** A site's discrepancies, errors first, in the server's order at equal severity. */
export function siteDiscrepancies(discrepancies: readonly Discrepancy[], slug: string): Discrepancy[] {
  return sortDiscrepancies(discrepancies.filter((discrepancy) => discrepancy.slug === slug))
}

const TONE_RANK: Record<Tone, number> = { neutral: 0, ok: 1, attention: 2, error: 3 }

/**
 * The site's state in one sentence: its service's word, then what its
 * discrepancies count. "Running, 1 warning", "Static files, 1 error". The tone
 * is the worse of the two: a running service on a site in error is still an
 * error.
 */
export function siteState(site: Pick<Site, "type" | "service">, discrepancies: readonly Discrepancy[]): ServiceState {
  const service = serviceState(site)
  const { errors, warnings } = countBySeverity(discrepancies)
  const parts = [service.label]
  if (errors > 0) parts.push(plural(errors, "error"))
  if (warnings > 0) parts.push(plural(warnings, "warning"))
  const discrepancyTone: Tone = errors > 0 ? "error" : warnings > 0 ? "attention" : "neutral"
  const tone = TONE_RANK[discrepancyTone] > TONE_RANK[service.tone] ? discrepancyTone : service.tone
  return { tone, label: parts.join(", ") }
}

// --- The service -----------------------------------------------------------------

/**
 * The two ticks on a service's gauge, in place of the machine's: the peak warns
 * at 80 % of the ceiling, the current memory alarms at 90 %, the bounds of
 * `serviceLevel`. Spelled out in full, for Tailwind; the tests check that they
 * follow the constants.
 */
export const SERVICE_THRESHOLD_POSITIONS: readonly { threshold: number; position: string }[] = [
  { threshold: PEAK_WARNING_SHARE * 100, position: "left-[80%]" },
  { threshold: MEMORY_CRITICAL_SHARE * 100, position: "left-[90%]" },
]

export const SERVICE_THRESHOLDS_TITLE = `Warning once the peak reaches ${PEAK_WARNING_SHARE * 100}% of the limit, critical above ${MEMORY_CRITICAL_SHARE * 100}%`

export type ServiceGauge = {
  tile: Tile
  /** Where the peak sits on the track, as a percentage capped at one hundred, or null with no peak and no ceiling. */
  peak: number | null
  /** "Peak 221 MB, 86% of the limit". */
  peakDetail: string
}

export type ServiceCard =
  | { kind: "static" }
  | { kind: "no-manifest" }
  | {
      kind: "app"
      state: ServiceState
      /** The systemd unit, or null when none is loaded. */
      unit: string | null
      /** "active (running)", what `systemctl status` displays. */
      systemd: string | null
      /** Null when the service is not running: no current memory to measure. */
      gauge: ServiceGauge | null
      facts: Fact[]
    }

function serviceGaugeOf(memory: number | null, peak: number | null, limit: number | null): ServiceGauge | null {
  if (memory === null) return null
  const partPic = peak === null || limit === null || limit <= 0 ? null : Math.round((peak / limit) * 100)
  return {
    tile: {
      heading: "Memory",
      percent: memoryShare(memory, limit),
      value: size(memory),
      detail: limit === null ? "No limit" : `of ${size(limit)}`,
      level: serviceLevel(memory, peak, limit),
    },
    peak: partPic === null ? null : Math.min(100, partPic),
    peakDetail:
      peak === null ? "No peak recorded" : partPic === null ? `Peak ${size(peak)}` : `Peak ${size(peak)}, ${partPic}% of the limit`,
  }
}

/**
 * A site's service for its card. An app shows its memory gauge when it is
 * running, and its facts in every case: since when, CPU, restarts, port. A peak
 * stays useful on a service that is down, which may have died of its memory.
 */
export function serviceCard(
  site: Pick<Site, "type" | "service" | "port" | "listening">,
  now: number,
  timeZone?: string,
): ServiceCard {
  const service = site.service
  if (service === null && site.type === "static") return { kind: "static" }
  if (service === null && site.type === "no-manifest") return { kind: "no-manifest" }

  const state = serviceState(site)
  const facts: Fact[] = []
  const active = service?.active === "active"

  if (service !== null && active) {
    facts.push(
      service.since === null
        ? fact("Up", ABSENT)
        : fact("Up", duration(now - service.since), `since ${dateTime(service.since, timeZone)}`),
    )
    facts.push(
      service.cpuShare === null
        ? fact("CPU", ABSENT, "Measured from the next collection")
        : fact("CPU", computeCpuShare(service.cpuShare), "of one core, over the last minute"),
    )
  }

  if (service !== null) {
    const restarts = service.restarts
    facts.push(
      fact(
        "Restarts",
        restarts === null ? ABSENT : String(restarts),
        "Automatic restarts by systemd",
        restarts !== null && restarts > 0 ? "attention" : "neutral",
      ),
    )
    if (!active && service.peak !== null) {
      facts.push(
        fact("Memory peak", size(service.peak), service.limit === null ? null : `of ${size(service.limit)}`),
      )
    }
  }

  if (site.port !== null) {
    facts.push(
      site.listening === false
        ? fact("Port", String(site.port), "Nothing listens on it", "error")
        : fact("Port", String(site.port), "Listening on the loopback interface"),
    )
  }

  return {
    kind: "app",
    state,
    unit: service === null ? null : `${service.unit}.service`,
    systemd: service === null ? null : `${service.active} (${service.subState})`,
    gauge: service === null || !active ? null : serviceGaugeOf(service.memory, service.peak, service.limit),
    facts,
  }
}

// --- The addresses ---------------------------------------------------------------

export type AddressRow = {
  name: string
  /** Null when the address does not answer: a link to it would lead nowhere. */
  href: string | null
  role: "domain" | "alias" | "preversion" | "main"
  /** The domain's state; the aliases and the preview address have none of their own. */
  state: ServiceState | null
  detail: string | null
}

/**
 * A site's addresses: its domain and its aliases if it declares one, then the
 * address under the zone, which always answers. A domain only answers once
 * routed; active or not only says what the manifest asks for.
 */
export function siteAddresses(site: Pick<Site, "slug" | "address" | "domain">): AddressRow[] {
  const lines: AddressRow[] = []
  const domain = site.domain
  if (domain !== null) {
    const href = domain.route ? `https://${domain.name}` : null
    const [state, detail]: [ServiceState, string] =
      domain.active && domain.route
        ? [{ tone: "ok", label: "Active" }, "Routed by Caddy"]
        : domain.active
          ? [{ tone: "error", label: "Not routed" }, "Active in sitesolide.json, missing from the routing table"]
          : domain.route
            ? [{ tone: "attention", label: "Routed, not active" }, "In the routing table, no longer active in sitesolide.json"]
            : [{ tone: "neutral", label: "Pending" }, "Declared in sitesolide.json, not active yet"]
    lines.push({ name: domain.name, href, role: "domain", state, detail })
    for (const aliases of domain.aliases) {
      lines.push({
        name: aliases,
        href: domain.route ? `https://${aliases}` : null,
        role: "alias",
        state: null,
        detail: `Alias of ${domain.name}`,
      })
    }
  }
  // The landing serves the bare domain, which already carries its name: this is not a preview address.
  const main = site.address === site.slug
  lines.push({
    name: site.address,
    href: `https://${site.address}`,
    role: main ? "main" : "preversion",
    state: null,
    detail: main ? "Main address" : "Preview address, always served",
  })
  return lines
}

// --- The door --------------------------------------------------------------------

/** A door seen from both sides: what the manifest asks for, what the machine applies. */
export type Check = { door: string; requested: string; applied: string; tone: Tone }

export type AccessReading = {
  access: Access
  title: string
  tone: Tone
  detail: string
  /** The doors at play, requested or applied: empty for a site with no door. */
  checks: Check[]
}

const ANOMALY_DETAILS: Record<Mismatch, string> = {
  "portal-absent":
    "sitesolide.json asks for the portal, but the live Caddy block doesn't apply it: anyone can reach the site.",
  "portal-extra":
    "The live Caddy block applies the portal, but sitesolide.json no longer asks for it. The site stays closed.",
  "code-without-lock": "A preview code is in effect, but sitesolide.json no longer asks for a lock.",
  "lock-without-code":
    "sitesolide.json asks for a lock, but the server has no valid code: the next regeneration will fail.",
}

/**
 * A site's door for its card: its name, what it does to the visitor, and each
 * door at play from both sides, so that a disagreement reads without having to
 * go back to the discrepancy's message.
 */
export function readAccess(site: Pick<Site, "type" | "portal" | "lock">): AccessReading {
  const access = siteAccess(site)
  const { portal, lock } = site
  const checks: Check[] = []
  if (portal.wanted || portal.installed) {
    checks.push({
      door: "Portal",
      requested: portal.wanted ? "Requested" : "Not requested",
      applied: portal.installed ? "In the live Caddy block" : "Missing from the live Caddy block",
      tone: portal.wanted === portal.installed ? "ok" : "error",
    })
  }
  if (lock.closed || lock.code !== null) {
    checks.push({
      door: "Preview lock",
      requested: lock.closed ? "Requested" : "Not requested",
      applied: lock.code === null ? "No code on the server" : "Code in effect",
      tone: lock.closed === (lock.code !== null) ? "ok" : "error",
    })
  }

  switch (access.kind) {
    case "portal":
      return {
        access,
        title: "Portal",
        tone: "neutral",
        detail: "Visitors sign in through the shared portal before they reach the site.",
        checks,
      }
    case "code":
      return {
        access,
        title: "Preview lock",
        tone: "neutral",
        detail: "Visitors enter the code once, then their browser remembers it.",
        checks,
      }
    case "open":
      return {
        access,
        title: "No gate",
        tone: "neutral",
        detail:
          site.type === "app"
            ? "Neither a preview lock nor the portal: the app handles its own sign-in, if any."
            : "Neither a preview lock nor the portal: anyone with the address can see the site.",
        checks,
      }
    case "mismatch":
      return { access, title: access.label, tone: "error", detail: ANOMALY_DETAILS[access.key], checks }
  }
}

// --- The storage -----------------------------------------------------------------

/**
 * The site's folder on the machine. The collector reads `/srv/sites`, and the
 * snapshot's slug is the folder's name, the landing included.
 */
export function siteFolder(slug: string): string {
  return `/srv/sites/${slug}`
}

/** The folder's size and the date of the last deployment, which the manifest dates. */
export function siteStorage(site: Pick<Site, "bytes" | "deployed">, now: number, timeZone?: string): Fact[] {
  return [
    fact("On disk", size(site.bytes)),
    site.deployed === null
      ? fact("Deployed", ABSENT, "No sitesolide.json to date it")
      : fact("Deployed", ago(now - site.deployed), dateTime(site.deployed, timeZone)),
  ]
}
