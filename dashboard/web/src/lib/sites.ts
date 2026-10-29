/**
 * What a site is, rather than how a component draws it: which address is the
 * main one, how the site opens, what its service says and what its services
 * weigh. Pure, and therefore testable without a browser. What the Sites list
 * keeps and in what order is lib/site-list.ts.
 *
 * Nothing is judged anew here: the discrepancies come from `src/state.ts`, and
 * the memory thresholds from lib/gauges.ts.
 */
import { ago, duration, fromNow, size, sizeOutOf } from "./format"
import { serviceLevel, type Level } from "./gauges"
import type { Tone } from "./tones"
import type { Site, SiteService } from "./types"

export const TYPE_LABELS: Record<Site["type"], string> = {
  app: "App",
  static: "Static",
  "no-manifest": "No manifest",
}

/** The tag beside the name of one of the platform's own projects, the word of its filter. */
export const PLATFORM_TAG = "Platform"

// --- The address -----------------------------------------------------------------

export type Address = {
  href: string
  text: string
  /** The second line: the other address, or what is wrong with the domain. */
  note: { text: string; warn: boolean } | null
}

/** What the address of a project that serves no page answers, said beside it. */
export const HEADLESS_NOTE = "Runs in the background, serves no page"

/**
 * The main link is the client's domain when it is active AND routed, the only
 * case where it really answers; otherwise the preview address, which always
 * answers. A project that serves no page has no domain, the manifest refuses
 * one: its address answers a line saying so, and the note says it first.
 */
export function siteAddress(site: Pick<Site, "address" | "domain" | "headless">): Address {
  const domain = site.domain
  const preview = { href: `https://${site.address}`, text: site.address }
  if (site.headless && domain === null) return { ...preview, note: { text: HEADLESS_NOTE, warn: false } }
  if (domain === null) return { ...preview, note: null }
  if (domain.active && domain.route) {
    return { href: `https://${domain.name}`, text: domain.name, note: { text: site.address, warn: false } }
  }
  if (domain.active) return { ...preview, note: { text: `${domain.name} not routed`, warn: true } }
  if (domain.route) return { ...preview, note: { text: `${domain.name} routed, not active`, warn: true } }
  return { ...preview, note: { text: `Pending: ${domain.name}`, warn: false } }
}

// --- General access ------------------------------------------------------------------

/** The four possible disagreements between what the manifest asks for and what is running. */
export type Mismatch = "portal-absent" | "portal-extra" | "code-without-lock" | "lock-without-code"

export type Access =
  /** `code` null: one is in force, withheld from whoever reads, a Viewer or a Developer. */
  | { kind: "code"; code: string | null; url: string | null }
  | { kind: "portal"; exemptions: string[] }
  | { kind: "open" }
  | { kind: "mismatch"; key: Mismatch; label: string }

/**
 * How the site opens. A code and a restriction never coexist: the manifest
 * refuses "portal" and "lock" together. A disagreement between the manifest and
 * what is running comes before everything else, because it is what leaves a
 * site open when its owner believes it closed.
 */
export function siteAccess(site: Pick<Site, "portal" | "lock">): Access {
  const { wanted, installed, exemptions } = site.portal
  if (wanted && !installed) {
    return { kind: "mismatch", key: "portal-absent", label: "Restricted in sitesolide.json, public on the server" }
  }
  if (!wanted && installed) {
    return { kind: "mismatch", key: "portal-extra", label: "Restricted on the server, public in sitesolide.json" }
  }
  if (wanted) return { kind: "portal", exemptions }

  const { closed, code, url } = site.lock
  // A code in force the snapshot does not show this reader: the site opens
  // with one, and an Admin of it holds it.
  if (closed && code === null && site.lock.withheld === true) return { kind: "code", code: null, url: null }
  if (!closed && code !== null) return { kind: "mismatch", key: "code-without-lock", label: "A code on the server, none in sitesolide.json" }
  if (closed && code === null) return { kind: "mismatch", key: "lock-without-code", label: "A code in sitesolide.json, none on the server" }
  if (closed && code !== null) return { kind: "code", code, url }
  return { kind: "open" }
}

// --- The service -----------------------------------------------------------------

/** A service's word, and its tone: what the Service column and the site card say first. */
export type ServiceState = { tone: Tone; label: string }

/**
 * A systemd unit's word, the same on every page: Sites reads it in the
 * snapshot, Secrets in what the steward reports.
 *
 * Any service that is not active is an error, as in the discrepancies of
 * `src/state.ts`; the word only says in what way it is not running.
 * `auto-restart` is systemd restarting a service that went down, in a loop if
 * it goes down every time.
 *
 * `active (exited)` is the anchor's state, the main unit of a project whose
 * every service is scheduled (isAnchored in bin/cli/manifest.ts): a oneshot
 * that runs nothing and stays active to keep their timers armed. No other
 * unit of a project exits and stays active, so the word says what the
 * project does, Scheduled, on Secrets as on its row.
 */
export function serviceWord(active: string, subState: string): ServiceState {
  if (active === "active") return subState === "exited" ? { tone: "ok", label: "Scheduled" } : { tone: "ok", label: "Running" }
  if (subState === "auto-restart") return { tone: "error", label: "Restarting" }
  if (active === "activating") return { tone: "error", label: "Starting" }
  if (active === "deactivating") return { tone: "error", label: "Stopping" }
  return { tone: "error", label: "Down" }
}

/** The word for a site's service: an app with no loaded unit is down, a static site has nothing to judge. */
export function serviceState(site: Pick<Site, "type" | "service">): ServiceState {
  const service = site.service
  if (service === null) {
    if (site.type === "static") return { tone: "neutral", label: "Static files" }
    if (site.type === "app") return { tone: "error", label: "Down" }
    return { tone: "neutral", label: "No manifest" }
  }
  return serviceWord(service.active, service.subState)
}

// --- Workers and scheduled services ------------------------------------------------

/**
 * Is every service of the project scheduled? Its main unit is then an anchor,
 * which runs nothing, and none of its services is the main one.
 */
export function isAnchoredSite(site: Pick<Site, "services">): boolean {
  return site.services.length > 0 && site.services.every((entry) => !entry.main)
}

/** systemd's shorthands for a calendar expression, which read as words. */
const SCHEDULE_SHORTHANDS = new Set(["minutely", "hourly", "daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "annually"])

/**
 * "Runs hourly" for one of systemd's shorthands; null for any other
 * expression, `*:0/15` or `Mon..Fri 08:00`, which the page shows as written
 * rather than translate it into words that might say something else.
 */
export function scheduleWords(expression: string): string | null {
  const word = expression.trim().toLowerCase()
  return SCHEDULE_SHORTHANDS.has(word) ? `Runs ${word}` : null
}

/** A unit in one of these states is running a program, about to, or about to stop. */
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"])

/**
 * A scheduled service's word and tone. Inactive between two runs is its
 * normal state, Waiting, never Down; what puts it in error is its timer, not
 * active, since nothing runs any more. A failed last run is a warning, as in
 * the discrepancies of `src/state.ts`: the next run may go well.
 */
export function scheduledWord(entry: Pick<SiteService, "service" | "schedule">): ServiceState {
  const { service, schedule } = entry
  if (service === null) return { tone: "error", label: "Not loaded" }
  const timer = schedule?.timerState ?? null
  if (timer !== null && !timer.loaded) return { tone: "error", label: "No timer" }
  if (timer !== null && timer.active !== "active") return { tone: "error", label: "Schedule stopped" }
  if (RUNNING_STATES.has(service.active)) return { tone: "ok", label: "Running" }
  if (schedule?.lastRun?.ok === false) return { tone: "attention", label: "Last run failed" }
  return { tone: "ok", label: "Waiting" }
}

/** A line under a scheduled service's word, and its tone. */
export type RunLine = { text: string; tone: Tone }

/**
 * When a scheduled service last ran and how, and when it runs next: "Last
 * run 3h ago", "Failed 3h ago: exit code 1" under its word, which already
 * says it was the last run, "Started 2m ago" while it runs, "Next run in
 * 42m". After a reboot systemd no longer knows how the last run ended, only
 * when its timer started it. No next run while the timer is stopped: the
 * word already says it.
 */
export function runLines(entry: Pick<SiteService, "service" | "schedule">, now: number): { last: RunLine | null; next: string | null } {
  const { service, schedule } = entry
  if (schedule === null) return { last: null, next: null }
  const next = schedule.next === null ? null : schedule.next <= now ? "Next run due now" : `Next run ${fromNow(schedule.next - now)}`
  const run = schedule.lastRun
  let last: RunLine | null
  if (service !== null && RUNNING_STATES.has(service.active)) {
    last = service.since === null ? null : { text: `Started ${ago(now - service.since)}`, tone: "neutral" }
  } else if (run !== null && !run.ok) {
    const when = run.at === null ? "" : ` ${ago(now - run.at)}`
    last = { text: `Failed${when}: ${run.failure ?? "no reason given"}`, tone: "attention" }
  } else if (run !== null && run.at !== null) {
    last = { text: `Last run ${ago(now - run.at)}`, tone: "neutral" }
  } else {
    // Not the timer's last trigger: a persistent timer stamps the moment it
    // was first started, at a deployment, as a trigger that ran nothing.
    last = { text: "No run yet", tone: "neutral" }
  }
  return { last, next }
}

export type ServiceSummary =
  | { kind: "static" }
  | { kind: "none" }
  | { kind: "stopped"; state: string; restarts: string | null }
  | {
      kind: "active"
      /** "61 of 256 MB", or the memory alone with no ceiling; null while nothing of the project runs, between two scheduled runs. */
      memory: string | null
      /** Memory over ceiling, capped at one hundred for the bar. */
      percent: number | null
      level: Level
      /** "3% CPU", or null before the second measurement. */
      cpu: string | null
      /** "up 20h", or null with no start date. */
      since: string | null
      restarts: string | null
      /** "3 services" for a project running several, whose figures above are then their sum. */
      services: string | null
      /** "next run in 12m", for a project whose every service is scheduled: the soonest of their runs. */
      next: string | null
    }

/** A share of a core: "3%", and "<1%" rather than a zero that would read as a sleeping service. */
export function computeCpuShare(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

/**
 * A share of one core as a share of the whole processor, 100 % being every
 * core busy: the Load gauge's scale, so that a site's CPU and the machine's
 * load read alike. Nothing without the number of cores.
 */
export function processorShare(cpuShare: number, cores: number | null): number | null {
  if (cores === null || cores <= 0) return null
  return cpuShare / cores
}

/** The cores a share of one core amounts to: "1.8 of 6 cores", "0.05 of 6 cores". */
export function coresUsed(cpuShare: number, cores: number): string {
  const used = cpuShare / 100
  const figure = used >= 10 ? String(Math.round(used)) : used >= 1 ? used.toFixed(1) : used >= 0.01 ? used.toFixed(2) : "<0.01"
  return `${figure} of ${cores} ${cores === 1 ? "core" : "cores"}`
}

/** What a site's CPU says in a title: its share of the processor, then in cores. */
export function processorTitle(cpuShare: number, cores: number | null): string {
  const share = processorShare(cpuShare, cores)
  if (share === null || cores === null) return `${computeCpuShare(cpuShare)} of one core, over the last minute`
  return `${computeCpuShare(share)} of the processor over the last minute, ${coresUsed(cpuShare, cores)}`
}

export function restartsLabel(count: number | null): string | null {
  if (!count) return null
  return `${count} restart${count > 1 ? "s" : ""}`
}

/** Memory over its ceiling, as a percentage capped at one hundred. Nothing without a known ceiling. */
export function memoryShare(memory: number | null, limit: number | null): number | null {
  if (memory === null || limit === null || limit <= 0) return null
  return Math.min(100, Math.round((memory / limit) * 100))
}

/** What a service's memory shows, the same everywhere: its ring's share and level, its figure, and the words of its tooltip. */
export type MemoryReading = { percent: number | null; level: Level; text: string; title: string }

/**
 * A service's memory, or a site's running services' together, as the Sites
 * list first drew it: an 18 px ring of it against the limit, in the level of
 * the service's own bounds, and the figure beside it. `full` writes the limit
 * after the figure, "47 of 256 MB", where there is room for it; the tooltip
 * says the limit, the share and the peak in any case.
 */
export function memoryReading(memory: number, peak: number | null, limit: number | null, full = false): MemoryReading {
  const percent = memoryShare(memory, limit)
  const peakWords = peak === null ? "" : limit === null || limit <= 0 ? `; peak ${size(peak)}` : `; peak ${size(peak)}, ${Math.round((peak / limit) * 100)}%`
  return {
    percent,
    level: serviceLevel(memory, peak, limit),
    text: full && limit !== null ? sizeOutOf(memory, limit) : size(memory),
    title: limit === null ? `${size(memory)}, no memory limit${peakWords}` : `${size(memory)} of its ${size(limit)} limit, ${percent}%${peakWords}`,
  }
}

/**
 * A site's service, as the inventory row shows it: memory against the ceiling,
 * the CPU share of the last minute, the restarts. The site card shows more, see
 * lib/site-card.ts.
 */
/** What a project's running services weigh together, each figure null when one of them lacks it. */
export type Weight = { counted: number; memory: number | null; peak: number | null; limit: number | null; cpuShare: number | null }

/**
 * A project of several services weighs what all of its running ones weigh:
 * the main one's figures alone would show a fraction of it. A figure one of
 * them lacks makes the sum unknown rather than wrong. A scheduled service
 * between two runs weighs nothing and holds no memory to measure, and the
 * anchor of a project whose every service is scheduled runs nothing:
 * neither is counted, rather than blank the sum for want of their figures.
 * Nothing is counted while the main unit is not active.
 */
export function siteWeight(site: Pick<Site, "service"> & Partial<Pick<Site, "services">>): Weight {
  const service = site.service
  const none: Weight = { counted: 0, memory: null, peak: null, limit: null, cpuShare: null }
  if (service === null || service.active !== "active") return none
  const entries = site.services ?? []
  const anchored = isAnchoredSite({ services: entries })
  const counted = [
    ...(anchored ? [] : [service]),
    ...entries
      .filter((entry) => !entry.main && (entry.kind !== "scheduled" || entry.service?.active === "active"))
      .map((entry) => entry.service),
  ]
  if (counted.length === 0) return none
  const sum = (pick: (entry: NonNullable<Site["service"]>) => number | null): number | null => {
    let total = 0
    for (const entry of counted) {
      const value = entry === null ? null : pick(entry)
      if (value === null) return null
      total += value
    }
    return total
  }
  return {
    counted: counted.length,
    memory: sum((entry) => entry.memory),
    peak: sum((entry) => entry.peak),
    limit: sum((entry) => entry.limit),
    cpuShare: sum((entry) => entry.cpuShare),
  }
}

export function serviceSummaryOf(site: Pick<Site, "type" | "service"> & Partial<Pick<Site, "services">>, now: number): ServiceSummary {
  const service = site.service
  if (service === null) {
    if (site.type === "static") return { kind: "static" }
    if (site.type === "app") return { kind: "stopped", state: "not loaded", restarts: null }
    return { kind: "none" }
  }
  const restarts = restartsLabel(service.restarts)
  if (service.active !== "active") return { kind: "stopped", state: service.active, restarts }

  const entries = site.services ?? []
  const anchored = isAnchoredSite({ services: entries })
  const { counted, memory, peak, limit, cpuShare } = siteWeight(site)
  const soonest = anchored
    ? entries.reduce<number | null>((first, entry) => {
        const next = entry.schedule?.next ?? null
        return next !== null && (first === null || next < first) ? next : first
      }, null)
    : null
  return {
    kind: "active",
    memory: counted === 0 ? null : limit === null ? size(memory) : sizeOutOf(memory, limit),
    percent: memoryShare(memory, limit),
    level: serviceLevel(memory, peak, limit),
    cpu: cpuShare === null ? null : `${computeCpuShare(cpuShare)} CPU`,
    since: service.since === null ? null : `up ${duration(now - service.since)}`,
    restarts,
    services: entries.length > 1 ? `${entries.length} services` : null,
    next: soonest === null ? null : soonest <= now ? "next run due now" : `next run ${fromNow(soonest - now)}`,
  }
}

// --- The click on a row ----------------------------------------------------------

/** Every list's row click, which the sites list was the first to need: see lib/rows.ts. */
export { rowClickOutcome, INTERACTIVE } from "./rows"
