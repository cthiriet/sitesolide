/**
 * What a site's card composes from the snapshot: its discrepancies, its state
 * in one sentence, its service, its addresses, its general access and its storage. Pure,
 * and therefore testable without a browser.
 *
 * Nothing is judged anew here. The discrepancies come from `src/state.ts`,
 * which decides what is wrong; the memory thresholds from lib/gauges.ts, which
 * takes its own from there; the card only arranges and names.
 */
import { ABSENT, dateTime, duration, ago, plural, size, sizeOutOf } from "./format"
import { serviceLevel, MEMORY_CRITICAL_SHARE, PEAK_WARNING_SHARE, type Level, type Tile } from "./gauges"
import {
  siteAccess,
  serviceState,
  serviceWord,
  computeCpuShare,
  isAnchoredSite,
  memoryShare,
  restartsLabel,
  runLines,
  scheduleWords,
  scheduledWord,
  type Access,
  type Mismatch,
  type RunLine,
  type ServiceState,
} from "./sites"
import { actorLabel } from "./audit"
import { KIND_WORDS, siteKind, type Kind } from "./legend"
import { fileProblems } from "./secrets"
import type { Tone } from "./tones"
import type { Audience, AuditRow, Discrepancy, ProjectView, Site, SiteService } from "./types"
import { countBySeverity, sortDiscrepancies } from "./verdict"

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
  /** What the row says beside its track: "131 of 256 MB", or the memory alone with no ceiling. */
  amount: string
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
      /** "Service", "Main service" beside others, "Main unit" for the anchor of a project whose every service is scheduled. */
      title: string
      state: ServiceState
      /** The systemd unit, or null when none is loaded. */
      unit: string | null
      /** "active (running)", what `systemctl status` displays. */
      systemd: string | null
      /** How long it has been up, "20h", and since when; null when it is not active. */
      uptime: { value: string; since: string | null } | null
      /** Null when the service is not running: no current memory to measure. */
      gauge: ServiceGauge | null
      /** What the panel says in place of the gauge, why there is none. */
      note: string | null
      facts: Fact[]
    }

function serviceGaugeOf(memory: number | null, peak: number | null, limit: number | null): ServiceGauge | null {
  if (memory === null) return null
  const peakShare = peak === null || limit === null || limit <= 0 ? null : Math.round((peak / limit) * 100)
  return {
    amount: limit === null ? size(memory) : sizeOutOf(memory, limit),
    tile: {
      heading: "Memory",
      percent: memoryShare(memory, limit),
      value: size(memory),
      detail: limit === null ? "No limit" : `of ${size(limit)}`,
      level: serviceLevel(memory, peak, limit),
    },
    peak: peakShare === null ? null : Math.min(100, peakShare),
    peakDetail:
      peak === null ? "No peak recorded" : peakShare === null ? `Peak ${size(peak)}` : `Peak ${size(peak)}, ${peakShare}% of the limit`,
  }
}

/**
 * What reaches a service, or what starts it: the paths it claims, every path
 * no other service claims, only the project's other services; nothing for a
 * worker, which runs in the background; its timer for a scheduled service, at
 * the times its schedule names, in words when systemd has some for them.
 */
export type Reach =
  | { kind: "paths"; paths: string[] }
  | { kind: "rest" }
  | { kind: "internal" }
  | { kind: "background" }
  | { kind: "scheduled"; words: string | null; expression: string; timer: string }

/** One line of the Services panel: a process of a project that runs several, or of one whose every service is scheduled. */
export type ServiceRow = {
  name: string
  /** The unit as systemctl takes it. */
  unit: string
  kind: SiteService["kind"]
  reach: Reach
  port: string | null
  /** False when the port is declared and nothing listens on it. */
  listening: boolean | null
  state: ServiceState
  /** "47 of 256 MB" while it runs, null otherwise. */
  memory: string | null
  /** Memory over its ceiling, for the bar; null without a known ceiling. */
  memoryPercent: number | null
  memoryLevel: Level
  restarts: string | null
  /** A scheduled service's last run and next one, under its word; null for any other. */
  runs: { last: RunLine | null; next: string | null } | null
}

function reachOf(entry: SiteService): Reach {
  if (entry.schedule !== null) {
    const { expression, timer } = entry.schedule
    return { kind: "scheduled", words: scheduleWords(expression), expression, timer }
  }
  if (entry.kind === "worker") return { kind: "background" }
  if (entry.internal) return { kind: "internal" }
  return entry.routes === null ? { kind: "rest" } : { kind: "paths", paths: entry.routes }
}

/**
 * The rows of the Services panel, the main service first. Empty for a project
 * with a single service, which the Service panel already describes whole;
 * never for a project whose every service is scheduled, whose Service panel
 * describes its anchor and none of them.
 *
 * A scheduled service's word is its own, see scheduledWord: between two runs
 * it is Waiting, never Down.
 */
export function serviceRows(site: Pick<Site, "services">, now: number): ServiceRow[] {
  if (site.services.length < 2 && !isAnchoredSite(site)) return []
  return site.services.map((entry) => {
    const service = entry.service
    const running = service !== null && service.active === "active"
    const state: ServiceState =
      entry.kind === "scheduled"
        ? scheduledWord(entry)
        : service === null
          ? { tone: "error", label: "Not loaded" }
          : serviceWord(service.active, service.subState)
    return {
      name: entry.name ?? entry.unit,
      unit: `${entry.unit}.service`,
      kind: entry.kind,
      reach: reachOf(entry),
      port: entry.port === null ? null : String(entry.port),
      listening: entry.listening,
      state,
      memory: !running ? null : service.limit === null ? size(service.memory) : sizeOutOf(service.memory, service.limit),
      memoryPercent: running ? memoryShare(service.memory, service.limit) : null,
      memoryLevel: running ? serviceLevel(service.memory, service.peak, service.limit) : "normal",
      restarts: restartsLabel(service?.restarts ?? null),
      runs: entry.kind === "scheduled" ? runLines(entry, now) : null,
    }
  })
}

/** The panel's title: what the main unit stands for beside the project's other services. */
function serviceTitle(site: Pick<Site, "services">): string {
  if (isAnchoredSite(site)) return "Main unit"
  return site.services.length > 1 ? "Main service" : "Service"
}

/**
 * A site's service for its card. An app shows its memory gauge when it is
 * running, and its facts in every case: since when, CPU, restarts, port. A peak
 * stays useful on a service that is down, which may have died of its memory.
 *
 * A project whose every service is scheduled shows its anchor: active, it
 * keeps their timers armed, and the Services panel shows them. A worker,
 * main service of a project that serves no page, says it has no port rather
 * than leave the fact out.
 */
export function serviceCard(
  site: Pick<Site, "type" | "service" | "port" | "listening" | "services" | "headless">,
  now: number,
  timeZone?: string,
): ServiceCard {
  const service = site.service
  if (service === null && site.type === "static") return { kind: "static" }
  if (service === null && site.type === "no-manifest") return { kind: "no-manifest" }

  const active = service?.active === "active"
  const facts: Fact[] = []
  // What the anchor and any other main unit both show.
  const card = {
    kind: "app" as const,
    title: serviceTitle(site),
    state: serviceState(site),
    unit: service === null ? null : `${service.unit}.service`,
    systemd: service === null ? null : `${service.active} (${service.subState})`,
    // An anchor's uptime says nothing of its services, which start and stop on their own schedule.
    uptime:
      service === null || !active || isAnchoredSite(site)
        ? null
        : service.since === null
          ? { value: ABSENT, since: null }
          : { value: duration(now - service.since), since: `since ${dateTime(service.since, timeZone)}` },
    facts,
  }

  if (isAnchoredSite(site)) {
    return {
      ...card,
      gauge: null,
      note:
        service === null
          ? "No systemd unit is loaded for this project: none of its services runs."
          : active
            ? "Every service of this project runs on a schedule, listed below. This unit runs nothing: it keeps their timers armed, at boot and after each deployment."
            : "This unit isn't active, so the timers of the project's services are stopped and none of them runs.",
    }
  }

  if (service !== null && active) {
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
        fact("Memory peak", service.limit === null ? size(service.peak) : sizeOutOf(service.peak, service.limit)),
      )
    }
  }

  if (site.port !== null) {
    facts.push(
      site.listening === false
        ? fact("Port", String(site.port), "Nothing listens on it", "error")
        : fact("Port", String(site.port), "Listening on the loopback interface"),
    )
  } else if (site.services.find((entry) => entry.main)?.kind === "worker") {
    facts.push(fact("Port", "None", "A worker: it runs in the background and listens on nothing"))
  }

  const gauge = service === null || !active ? null : serviceGaugeOf(service.memory, service.peak, service.limit)
  return {
    ...card,
    gauge,
    note:
      gauge !== null
        ? null
        : service === null
          ? site.headless
            ? "No systemd unit is loaded for this app: none of its services runs."
            : "No systemd unit is loaded for this app: nothing answers behind Caddy."
          : active
            ? "systemd reports no memory for it."
            : "The service isn't running, so it has no memory in use.",
  }
}

// --- The addresses ---------------------------------------------------------------

export type AddressRow = {
  name: string
  /** Null when the address does not answer: a link to it would lead nowhere. */
  href: string | null
  role: "domain" | "alias" | "preview" | "main"
  /** The domain's state; the aliases and the preview address have none of their own. */
  state: ServiceState | null
  detail: string | null
}

/**
 * A site's addresses: its domain and its aliases if it declares one, then the
 * address under the zone, which always answers. A domain only answers once
 * routed; active or not only says what the manifest asks for. The address of
 * a project that serves no page answers a line saying it runs in the
 * background, and says so.
 */
export function siteAddresses(site: Pick<Site, "slug" | "address" | "domain" | "headless">): AddressRow[] {
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
    for (const alias of domain.aliases) {
      lines.push({
        name: alias,
        href: domain.route ? `https://${alias}` : null,
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
    role: main ? "main" : "preview",
    state: null,
    detail: site.headless
      ? "Serves no page: it answers that the project runs in the background"
      : main
        ? "Main address"
        : "Preview address, always served",
  })
  return lines
}

// --- General access ------------------------------------------------------------------

/** A setting seen from both sides: what the manifest asks for, what the machine applies. */
export type Check = { setting: string; requested: string; applied: string; tone: Tone }

export type AccessReading = {
  access: Access
  title: string
  tone: Tone
  detail: string
  /** The settings at play, requested or applied: empty for a public site. */
  checks: Check[]
}

const ANOMALY_DETAILS: Record<Mismatch, string> = {
  "portal-absent":
    "sitesolide.json asks for Restricted, but the live Caddy block doesn't apply it: anyone can open the site.",
  "portal-extra":
    "The live Caddy block restricts the site, but sitesolide.json no longer asks for it. The site stays restricted.",
  "code-without-lock": "A preview code is in effect, but sitesolide.json no longer asks for one.",
  "lock-without-code":
    "sitesolide.json asks for a preview code, but the server has no valid one: choose one in Access to mend it.",
}

/**
 * A site's general access for its card: its name, what it does to the visitor,
 * and each setting at play from both sides, so that a disagreement reads without having to
 * go back to the discrepancy's message. `plain`: for a Viewer or a Developer,
 * who never touch the machine, Restricted reads Applied or Not applied; the
 * owner and Admins read where it is applied, the live Caddy block.
 */
export function readAccess(site: Pick<Site, "type" | "portal" | "lock" | "headless">, plain = false): AccessReading {
  const access = siteAccess(site)
  const { portal, lock } = site
  const checks: Check[] = []
  if (portal.wanted || portal.installed) {
    checks.push({
      setting: "Restricted",
      requested: portal.wanted ? "Requested" : "Not requested",
      applied: plain ? (portal.installed ? "Applied" : "Not applied") : portal.installed ? "In the live Caddy block" : "Missing from the live Caddy block",
      tone: portal.wanted === portal.installed ? "ok" : "error",
    })
  }
  if (lock.closed || lock.code !== null) {
    const inForce = lock.code !== null || lock.withheld === true
    checks.push({
      setting: "Preview code",
      requested: lock.closed ? "Requested" : "Not requested",
      applied: inForce ? "Code in effect" : "No code on the server",
      tone: lock.closed === inForce ? "ok" : "error",
    })
  }

  switch (access.kind) {
    case "portal":
      return {
        access,
        title: "Restricted",
        tone: "neutral",
        detail: "Only the people with access can open the site, once signed in.",
        checks,
      }
    case "code":
      return {
        access,
        title: "Anyone with the code",
        tone: "neutral",
        detail: "Visitors enter the preview code once, then their browser remembers it.",
        checks,
      }
    case "open":
      return {
        access,
        title: "Public",
        tone: "neutral",
        detail: site.headless
          ? "Anyone with the address reads that the project runs in the background: it serves no page."
          : site.type === "app"
            ? "Anyone with the address can open the site: the app handles its own sign-in, if any."
            : "Anyone with the address can open the site.",
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

/**
 * The folder's size, its path in the tooltip, and the date of the last
 * deployment, which the manifest dates.
 */
export function siteStorage(site: Pick<Site, "slug" | "bytes" | "deployed">, now: number, timeZone?: string): Fact[] {
  return [
    fact("Disk", size(site.bytes), siteFolder(site.slug)),
    site.deployed === null
      ? fact("Deployed", ABSENT, "No sitesolide.json to date it")
      : fact("Deployed", ago(now - site.deployed), dateTime(site.deployed, timeZone)),
  ]
}

// --- The kind --------------------------------------------------------------------

/**
 * What the project is, under its title: its kind's word, and how many
 * services it runs when it runs several. "App", "Static site", "Background,
 * 3 services". The tooltip says the kind's sentence (lib/legend.ts).
 */
export function kindLine(site: Pick<Site, "type" | "headless" | "services">): { kind: Kind; text: string } {
  const kind = siteKind(site)
  const count = site.services.length
  const text = count > 1 ? `${KIND_WORDS[kind].label}, ${plural(count, "service")}` : KIND_WORDS[kind].label
  return { kind, text }
}

/**
 * The state said beside the kind under the title, quiet when fine: nothing
 * for a running app, nor for a static site or a folder with no manifest,
 * whose kind already says there is nothing to run; the word in its tone
 * otherwise, with what the discrepancies count. Null when there is nothing
 * to say.
 */
export function headerState(site: Pick<Site, "type" | "service">, discrepancies: readonly Discrepancy[]): ServiceState | null {
  const state = siteState(site, discrepancies)
  if (state.tone === "ok") return null
  if (state.tone === "neutral" && site.type !== "app") return null
  return state
}

// --- The Site panel --------------------------------------------------------------

/**
 * The Site panel's Address: the address that answers, a link; a domain that
 * does not answer as asked, in its state's word (Pending, Not routed);
 * under it, muted, the other addresses it answers on. A project that serves
 * no page says so instead of being offered as a page.
 */
export type AddressSummary = {
  name: string
  href: string
  /** The declared domain when it is not the one that answers, or not as asked: its name and its state. */
  domain: { name: string; state: ServiceState } | null
  /** Every other address it answers on: the aliases and the preview under an active domain. */
  others: string[]
  headless: boolean
}

export function addressSummary(site: Pick<Site, "slug" | "address" | "domain" | "headless">): AddressSummary {
  const lines = siteAddresses(site)
  const preview = lines[lines.length - 1]!
  const domain = lines.find((line) => line.role === "domain") ?? null
  const routed = domain !== null && domain.href !== null && domain.state?.tone === "ok"
  if (domain !== null && routed) {
    return {
      name: domain.name,
      href: domain.href!,
      domain: null,
      others: lines.filter((line) => line !== domain).map((line) => line.name),
      headless: site.headless,
    }
  }
  return {
    name: preview.name,
    href: preview.href!,
    domain: domain === null || domain.state === null ? null : { name: domain.name, state: domain.state },
    others: [],
    headless: site.headless,
  }
}

/**
 * The Site panel's Secrets, in one line: what the project keeps, counted,
 * never a name, and what needs a look, the Secrets section's own problems
 * (lib/secrets.ts `fileProblems`), so that the row and the sidebar's badge
 * count the same things. The first problem is said, the others counted.
 */
export type SecretsHeadline = {
  text: string
  problem: { text: string; tone: Tone; more: number; title: string } | null
}

export function secretsHeadline(project: ProjectView, serverNow: number): SecretsHeadline {
  const store = project.store
  const variables = store?.variables.length ?? 0
  const files = (store?.files.length ?? 0) + project.files.length
  const pieces = [variables > 0 ? plural(variables, "variable") : null, files > 0 ? plural(files, "file") : null].filter(
    (piece): piece is string => piece !== null,
  )
  const problems = fileProblems(project, serverNow)
  const first = problems[0]
  return {
    text: pieces.length === 0 ? "None" : pieces.join(", "),
    problem:
      first === undefined
        ? null
        : {
            text: first.label,
            tone: first.tone,
            more: problems.length - 1,
            title: problems.map((problem) => ("file" in problem ? `${problem.file}: ${problem.label}` : problem.label)).join(". "),
          },
  }
}

/**
 * The Site panel's Audience, in one line: the visits over the window
 * analytics keeps, "1,148 visits in 30 days"; muted words when there is
 * nothing to count yet.
 */
export function audienceHeadline(audience: Pick<Audience, "present" | "days" | "sites"> | null, slug: string): { text: string; measured: boolean } {
  if (audience === null || !audience.present) return { text: "No audience data", measured: false }
  const measure = audience.sites[slug]
  if (measure === undefined) return { text: "Not measured yet", measured: false }
  return { text: `${NUMBER.format(measure.visits)} ${measure.visits === 1 ? "visit" : "visits"} in ${plural(audience.days, "day")}`, measured: true }
}

const NUMBER = new Intl.NumberFormat("en-US")

/** A deployment recorded this close to the manifest's date is the one that dated it. */
export const SAME_DEPLOYMENT_MS = 15 * 60_000

/**
 * Who made the deployment the manifest dates, in Activity's words: the
 * latest success recorded for the site, when it is that deployment. Null
 * otherwise, a folder copied by hand or a history that does not reach it.
 */
export function deployedBy(rows: readonly AuditRow[], deployed: number | null): string | null {
  const row = rows.find((candidate) => candidate.action === "deploy.success")
  if (row === undefined || deployed === null) return null
  const at = Date.parse(row.at)
  return Number.isFinite(at) && Math.abs(at - deployed) <= SAME_DEPLOYMENT_MS ? actorLabel(row) : null
}
