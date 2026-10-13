import { describe, expect, test } from "bun:test"
import { MEMORY_CRITICAL_SHARE, PEAK_WARNING_SHARE } from "../src/lib/gauges"
import {
  SERVICE_THRESHOLD_POSITIONS,
  siteAddresses,
  siteFolder,
  siteDiscrepancies,
  siteState,
  serviceCard,
  serviceRows,
  readAccess,
  siteStorage,
} from "../src/lib/site-card"
import { discrepancy, scheduledService, service, site, siteService } from "./factory"

const MO = 1024 ** 2
const HOUR = 3600_000
const NOW = Date.UTC(2027, 0, 15, 12, 0)

describe("a site's discrepancies", () => {
  test("only its own, errors first, the server's order at equal severity", () => {
    const discrepancies = [
      discrepancy("warning", "cms", "peak"),
      discrepancy("error", "calendar", "other site"),
      discrepancy("error", null, "machine"),
      discrepancy("warning", "cms", "domain"),
      discrepancy("error", "cms", "port"),
    ]
    expect(siteDiscrepancies(discrepancies, "cms").map((e) => e.message)).toEqual(["port", "peak", "domain"])
    expect(siteDiscrepancies(discrepancies, "unknown")).toEqual([])
  })
})

describe("a site's state", () => {
  test("the service's word alone when nothing is wrong", () => {
    expect(siteState(site(), [])).toEqual({ tone: "ok", label: "Running" })
    expect(siteState(site({ type: "static", service: null }), [])).toEqual({ tone: "neutral", label: "Static files" })
  })

  test("the discrepancies are added to the word, counted by severity", () => {
    expect(siteState(site(), [discrepancy("warning")])).toEqual({ tone: "attention", label: "Running, 1 warning" })
    expect(
      siteState(site({ type: "static", service: null }), [discrepancy("error"), discrepancy("error"), discrepancy("warning")]),
    ).toEqual({ tone: "error", label: "Static files, 2 errors, 1 warning" })
  })

  /** A downed service is already an error: one more warning does not soften it. */
  test("the tone is the worse of the two", () => {
    const tombe = site({ service: service({ active: "activating", subState: "auto-restart" }) })
    expect(siteState(tombe, [discrepancy("warning")])).toEqual({ tone: "error", label: "Restarting, 1 warning" })
  })
})

describe("a site's service", () => {
  test("a static site or one with no manifest has no service to show", () => {
    expect(serviceCard(site({ type: "static", service: null, port: null }), NOW)).toEqual({ kind: "static" })
    expect(serviceCard(site({ type: "no-manifest", service: null, port: null }), NOW)).toEqual({
      kind: "no-manifest",
    })
  })

  test("an active service: its unit, its gauge and its facts", () => {
    const card = serviceCard(
      site({
        port: 3043,
        listening: true,
        service: service({
          unit: "cms",
          memory: 198 * MO,
          peak: 221 * MO,
          limit: 256 * MO,
          since: NOW - 20 * HOUR,
          cpuShare: 5.1,
          restarts: 0,
        }),
      }),
      NOW,
      "UTC",
    )
    expect(card).toEqual({
      kind: "app",
      title: "Service",
      state: { tone: "ok", label: "Running" },
      unit: "cms.service",
      systemd: "active (running)",
      gauge: {
        tile: { heading: "Memory", percent: 77, value: "198 MB", detail: "of 256 MB", level: "warn" },
        peak: 86,
        peakDetail: "Peak 221 MB, 86% of the limit",
      },
      note: null,
      facts: [
        { label: "Up", value: "20h", detail: "since Jan 14, 16:00 UTC", tone: "neutral" },
        { label: "CPU", value: "5%", detail: "of one core, over the last minute", tone: "neutral" },
        { label: "Restarts", value: "0", detail: "Automatic restarts by systemd", tone: "neutral" },
        { label: "Port", value: "3043", detail: "Listening on the loopback interface", tone: "neutral" },
      ],
    })
  })

  test("with no ceiling and no peak, the gauge says so rather than inventing a share", () => {
    const card = serviceCard(site({ service: service({ memory: 40 * MO, peak: null, limit: null }) }), NOW)
    expect(card).toMatchObject({
      gauge: { tile: { percent: null, detail: "No limit" }, peak: null, peakDetail: "No peak recorded" },
    })
  })

  test("a peak beyond the ceiling is capped on the track, not in the text", () => {
    const card = serviceCard(site({ service: service({ memory: 250 * MO, peak: 300 * MO, limit: 256 * MO }) }), NOW)
    expect(card).toMatchObject({ gauge: { peak: 100, peakDetail: "Peak 300 MB, 117% of the limit" } })
  })

  test("with no measured CPU share, a hyphen and when it will come", () => {
    const card = serviceCard(site({ service: service({ cpuShare: null, since: null }) }), NOW)
    expect(card.kind === "app" && card.facts.slice(0, 2)).toEqual([
      { label: "Up", value: "-", detail: null, tone: "neutral" },
      { label: "CPU", value: "-", detail: "Measured from the next collection", tone: "neutral" },
    ])
  })

  /** A service in a crash loop: no current memory, but the peak can say it died of its memory. */
  test("a downed service: no gauge, its restarts in attention, its peak and its silent port", () => {
    const card = serviceCard(
      site({
        port: 3045,
        listening: false,
        service: service({
          active: "activating",
          subState: "auto-restart",
          memory: null,
          peak: 34 * MO,
          limit: 256 * MO,
          restarts: 7,
        }),
      }),
      NOW,
    )
    expect(card).toEqual({
      kind: "app",
      title: "Service",
      state: { tone: "error", label: "Restarting" },
      unit: "calendar.service",
      systemd: "activating (auto-restart)",
      gauge: null,
      note: "The service isn't running, so it has no memory in use.",
      facts: [
        { label: "Restarts", value: "7", detail: "Automatic restarts by systemd", tone: "attention" },
        { label: "Memory peak", value: "34 MB", detail: "of 256 MB", tone: "neutral" },
        { label: "Port", value: "3045", detail: "Nothing listens on it", tone: "error" },
      ],
    })
  })

  test("an app with no loaded unit: no unit, no gauge, but its port", () => {
    expect(serviceCard(site({ service: null, port: 3040, listening: false }), NOW)).toEqual({
      kind: "app",
      title: "Service",
      state: { tone: "error", label: "Down" },
      unit: null,
      systemd: null,
      gauge: null,
      note: "No systemd unit is loaded for this app: nothing answers behind Caddy.",
      facts: [{ label: "Port", value: "3040", detail: "Nothing listens on it", tone: "error" }],
    })
    // A project that serves no page has nothing behind Caddy to answer: what stops is its services.
    expect(serviceCard(site({ service: null, port: null, headless: true }), NOW)).toMatchObject({
      note: "No systemd unit is loaded for this app: none of its services runs.",
    })
  })

  /** Tailwind only generates the classes that are written: every position has to follow its constant. */
  test("the gauge's ticks follow the service's thresholds", () => {
    expect(SERVICE_THRESHOLD_POSITIONS.map((tick) => tick.threshold)).toEqual([PEAK_WARNING_SHARE * 100, MEMORY_CRITICAL_SHARE * 100])
    for (const { threshold, position } of SERVICE_THRESHOLD_POSITIONS) expect(position).toBe(`left-[${threshold}%]`)
  })
})

describe("a site's addresses", () => {
  const domain = (active: boolean, route: boolean, aliases: string[] = []) => ({ name: "wheels.test", aliases, active, route })

  test("with no domain, the preview address alone, which always answers", () => {
    expect(siteAddresses(site())).toEqual([
      {
        name: "calendar.test-zone.invalid",
        href: "https://calendar.test-zone.invalid",
        role: "preversion",
        state: null,
        detail: "Preview address, always served",
      },
    ])
  })

  test("a domain active and routed, its aliases under it, then the preview address", () => {
    const lines = siteAddresses(site({ domain: domain(true, true, ["www.wheels.test"]) }))
    expect(lines.map((line) => [line.name, line.role, line.href])).toEqual([
      ["wheels.test", "domain", "https://wheels.test"],
      ["www.wheels.test", "alias", "https://www.wheels.test"],
      ["calendar.test-zone.invalid", "preversion", "https://calendar.test-zone.invalid"],
    ])
    expect(lines[0]?.state).toEqual({ tone: "ok", label: "Active" })
    expect(lines[1]?.detail).toBe("Alias of wheels.test")
  })

  /** A link to a domain Caddy does not route would lead nowhere. */
  test("an unrouted domain is not a link, and neither are its aliases", () => {
    const lines = siteAddresses(site({ domain: domain(true, false, ["www.wheels.test"]) }))
    expect(lines[0]).toMatchObject({ href: null, state: { tone: "error", label: "Not routed" } })
    expect(lines[1]?.href).toBeNull()
  })

  test("every state of the domain has its tone", () => {
    expect(siteAddresses(site({ domain: domain(false, true) }))[0]).toMatchObject({
      href: "https://wheels.test",
      state: { tone: "attention", label: "Routed, not active" },
    })
    expect(siteAddresses(site({ domain: domain(false, false) }))[0]).toMatchObject({
      href: null,
      state: { tone: "neutral", label: "Pending" },
    })
  })

  /** The landing serves the bare domain, which carries the name of its folder. */
  test("the address that carries the folder's name is the main address, not a preview one", () => {
    expect(siteAddresses(site({ slug: "test-zone.invalid", address: "test-zone.invalid" }))).toEqual([
      { name: "test-zone.invalid", href: "https://test-zone.invalid", role: "main", state: null, detail: "Main address" },
    ])
  })
})

describe("a site's door", () => {
  const portal = (wanted: boolean, installed: boolean, exemptions: string[] = []) => ({ wanted, installed, exemptions })
  const lock = (closed: boolean, code: string | null) => ({
    closed,
    code,
    url: code === null ? null : `https://a.test-zone.invalid/?key=${code}`,
  })

  test("public: no check, and what that means depending on the type", () => {
    expect(readAccess(site())).toMatchObject({ title: "Public", tone: "neutral", checks: [] })
    expect(readAccess(site()).detail).toContain("the app handles its own sign-in")
    expect(readAccess(site({ type: "static" })).detail).toContain("Anyone with the address")
    expect(readAccess(site({ headless: true })).detail).toBe("Anyone with the address reads that the project runs in the background: it serves no page.")
  })

  test("restricted, requested and applied", () => {
    expect(readAccess(site({ portal: portal(true, true, ["/api/*"]) }))).toMatchObject({
      access: { kind: "portal", exemptions: ["/api/*"] },
      title: "Restricted",
      tone: "neutral",
      checks: [{ setting: "Restricted", requested: "Requested", applied: "In the live Caddy block", tone: "ok" }],
    })
    // A Viewer or a Developer reads whether it applies, not where.
    expect(readAccess(site({ portal: portal(true, true) }), true).checks).toEqual([{ setting: "Restricted", requested: "Requested", applied: "Applied", tone: "ok" }])
    expect(readAccess(site({ portal: portal(true, false) }), true).checks).toEqual([{ setting: "Restricted", requested: "Requested", applied: "Not applied", tone: "error" }])
  })

  test("the preview code, requested and in effect", () => {
    expect(readAccess(site({ lock: lock(true, "K7PX3M") }))).toMatchObject({
      access: { kind: "code", code: "K7PX3M" },
      title: "Anyone with the code",
      checks: [{ setting: "Preview code", requested: "Requested", applied: "Code in effect", tone: "ok" }],
    })
  })

  /** The worst state: the manifest says closed, Caddy serves in the clear. The check shows which side. */
  test("a disagreement reads as an error, with the side that is missing", () => {
    const expose = readAccess(site({ portal: portal(true, false) }))
    expect(expose).toMatchObject({ title: "Restricted in sitesolide.json, public on the server", tone: "error" })
    expect(expose.detail).toContain("anyone can open the site")
    expect(expose.checks).toEqual([
      { setting: "Restricted", requested: "Requested", applied: "Missing from the live Caddy block", tone: "error" },
    ])

    expect(readAccess(site({ portal: portal(false, true) })).checks[0]).toMatchObject({
      requested: "Not requested",
      applied: "In the live Caddy block",
      tone: "error",
    })
    expect(readAccess(site({ lock: lock(false, "K7PX3M") })).checks[0]).toMatchObject({
      requested: "Not requested",
      applied: "Code in effect",
      tone: "error",
    })
    expect(readAccess(site({ lock: lock(true, null) })).checks[0]).toMatchObject({
      requested: "Requested",
      applied: "No code on the server",
      tone: "error",
    })
  })

  test("every disagreement has its explanation", () => {
    const details = [
      readAccess(site({ portal: portal(true, false) })).detail,
      readAccess(site({ portal: portal(false, true) })).detail,
      readAccess(site({ lock: lock(false, "K7PX3M") })).detail,
      readAccess(site({ lock: lock(true, null) })).detail,
    ]
    expect(new Set(details).size).toBe(4)
  })
})

describe("a site's storage", () => {
  test("the size and the date of the last deployment", () => {
    expect(siteStorage(site({ bytes: 48 * MO, deployed: NOW - 20 * HOUR }), NOW, "UTC")).toEqual([
      { label: "On disk", value: "48 MB", detail: null, tone: "neutral" },
      { label: "Deployed", value: "20h ago", detail: "Jan 14, 16:00 UTC", tone: "neutral" },
    ])
  })

  test("with no manifest, nothing dates the deployment", () => {
    expect(siteStorage(site({ bytes: null, deployed: null }), NOW)).toEqual([
      { label: "On disk", value: "-", detail: null, tone: "neutral" },
      { label: "Deployed", value: "-", detail: "No sitesolide.json to date it", tone: "neutral" },
    ])
  })

  test("the folder carries the slug, the landing included", () => {
    expect(siteFolder("cms")).toBe("/srv/sites/cms")
    expect(siteFolder("test-zone.invalid")).toBe("/srv/sites/test-zone.invalid")
  })
})

describe("a project's services", () => {
  const lab = site({
    slug: "lab",
    services: [
      siteService({ name: "web", unit: "lab", main: true, port: 3050, listening: true, service: service({ unit: "lab", memory: 47 * MO, limit: 256 * MO }) }),
      siteService({ name: "api", unit: "lab.api", port: 3051, listening: false, routes: ["/v1/*"], service: service({ unit: "lab.api", restarts: 2 }) }),
      siteService({ name: "worker", unit: "lab.worker", port: 3052, listening: true, internal: true, service: null }),
    ],
  })

  test("one row per service, the main one first, with what reaches it", () => {
    const rows = serviceRows(lab, NOW)
    expect(rows.map((row) => [row.name, row.unit, row.reach, row.port])).toEqual([
      ["web", "lab.service", { kind: "rest" }, "3050"],
      ["api", "lab.api.service", { kind: "paths", paths: ["/v1/*"] }, "3051"],
      ["worker", "lab.worker.service", { kind: "internal" }, "3052"],
    ])
  })

  test("its state, its memory, its restarts and a silent port", () => {
    const [web, api, worker] = serviceRows(lab, NOW)
    expect(web!.state).toEqual({ tone: "ok", label: "Running" })
    expect(web!.memory).toBe("47 of 256 MB")
    expect(web!.memoryPercent).toBe(18)
    expect(web!.memoryLevel).toBe("normal")
    expect(api!.listening).toBe(false)
    expect(api!.restarts).toBe("2 restarts")
    expect(worker!.state).toEqual({ tone: "error", label: "Not loaded" })
    expect(worker!.memory).toBeNull()
    expect(worker!.memoryPercent).toBeNull()
    expect(web!.runs).toBeNull()
  })

  test("a single service has no rows: the Service panel already says it all", () => {
    expect(serviceRows(site(), NOW)).toEqual([])
    expect(serviceRows(site({ services: [lab.services[0]!] }), NOW)).toEqual([])
  })

  test("the main panel is the main service beside others", () => {
    expect(serviceCard(lab, NOW)).toMatchObject({ kind: "app", title: "Main service" })
  })
})

describe("a project with a worker and scheduled services", () => {
  const MINUTE = 60_000
  /** A web front, a worker and an hourly job: the main unit is the web's. */
  const shop = site({
    slug: "shop",
    services: [
      siteService({ name: "web", unit: "shop", main: true, port: 3050, listening: true, service: service({ unit: "shop" }) }),
      siteService({ name: "queue", unit: "shop.queue", kind: "worker", internal: true, service: service({ unit: "shop.queue", memory: 30 * MO }) }),
      scheduledService(NOW, { unit: "shop.sync" }, { timer: "shop.sync.timer" }),
    ],
  })

  test("a worker runs in the background, and has no port to show", () => {
    const queue = serviceRows(shop, NOW)[1]!
    expect([queue.kind, queue.reach, queue.port, queue.state]).toEqual(["worker", { kind: "background" }, null, { tone: "ok", label: "Running" }])
    expect(queue.memory).toBe("30 of 256 MB")
  })

  test("a worker that is down is an error, as any service", () => {
    const down = site({ services: [shop.services[0]!, siteService({ kind: "worker", internal: true, service: service({ active: "failed", subState: "failed" }) })] })
    expect(serviceRows(down, NOW)[1]!.state).toEqual({ tone: "error", label: "Down" })
  })

  test("an idle scheduled service is waiting, never down, with its schedule, last run and next run", () => {
    const sync = serviceRows(shop, NOW)[2]!
    expect(sync.kind).toBe("scheduled")
    expect(sync.reach).toEqual({ kind: "scheduled", words: "Runs hourly", expression: "hourly", timer: "shop.sync.timer" })
    expect(sync.state).toEqual({ tone: "ok", label: "Waiting" })
    expect(sync.memory).toBeNull()
    expect(sync.runs).toEqual({ last: { text: "Last run 1h ago", tone: "neutral" }, next: "Next run in 15m" })
  })

  test("an expression with no words of its own is shown as written", () => {
    const quarter = site({ services: [scheduledService(NOW, {}, { expression: "*:0/15" })] })
    expect(serviceRows(quarter, NOW)[0]!.reach).toMatchObject({ words: null, expression: "*:0/15" })
  })

  test("a run in progress says when it started, and weighs what it weighs", () => {
    const running = scheduledService(NOW, { service: service({ unit: "shop.sync", active: "active", subState: "running", since: NOW - 2 * MINUTE, memory: 80 * MO }) }, { lastRun: null })
    const [row] = serviceRows(site({ services: [running] }), NOW)
    expect(row!.state).toEqual({ tone: "ok", label: "Running" })
    expect(row!.runs!.last).toEqual({ text: "Started 2m ago", tone: "neutral" })
    expect(row!.memory).toBe("80 of 256 MB")
  })

  test("a failed last run is a warning that says when and how", () => {
    const failed = scheduledService(
      NOW,
      { service: service({ unit: "shop.sync", active: "failed", subState: "failed", memory: null }) },
      { lastRun: { at: NOW - 3 * HOUR, ok: false, result: "exit-code", status: 1, failure: "exit code 1" } },
    )
    const [row] = serviceRows(site({ services: [failed] }), NOW)
    expect(row!.state).toEqual({ tone: "attention", label: "Last run failed" })
    expect(row!.runs!.last).toEqual({ text: "Failed 3h ago: exit code 1", tone: "attention" })
  })

  test("a timer that is not active is an error, and gives no next run", () => {
    const stopped = scheduledService(NOW, {}, { timerState: { loaded: true, active: "inactive", subState: "dead" }, next: null })
    const [row] = serviceRows(site({ services: [stopped] }), NOW)
    expect(row!.state).toEqual({ tone: "error", label: "Schedule stopped" })
    expect(row!.runs!.next).toBeNull()
    const missing = scheduledService(NOW, {}, { timerState: { loaded: false, active: "inactive", subState: "dead" } })
    expect(serviceRows(site({ services: [missing] }), NOW)[0]!.state).toEqual({ tone: "error", label: "No timer" })
  })

  test("a timer the collector did not read is judged as nothing", () => {
    const unread = scheduledService(NOW, {}, { timerState: null, next: null })
    expect(serviceRows(site({ services: [unread] }), NOW)[0]!.state).toEqual({ tone: "ok", label: "Waiting" })
  })

  test("after a reboot, the timer still says when it last ran, and before the first run, that none has", () => {
    const rebooted = scheduledService(NOW, {}, { lastRun: null, lastTrigger: NOW - 5 * HOUR })
    expect(serviceRows(site({ services: [rebooted] }), NOW)[0]!.runs!.last).toEqual({ text: "Last started 5h ago", tone: "neutral" })
    const fresh = scheduledService(NOW, {}, { lastRun: null, lastTrigger: null })
    expect(serviceRows(site({ services: [fresh] }), NOW)[0]!.runs!.last).toEqual({ text: "No run yet", tone: "neutral" })
  })

  test("each row says its kind, the main service first", () => {
    expect(serviceRows(shop, NOW).map((row) => row.kind)).toEqual(["server", "worker", "scheduled"])
  })
})

describe("a project whose every service is scheduled", () => {
  /** Its main unit is an anchor: active (exited), no memory, none of its services is the main one. */
  const anchor = service({ unit: "reports", subState: "exited", memory: null, peak: null, limit: null, cpuShare: null, since: NOW - 3 * HOUR })
  const reports = site({ slug: "reports", headless: true, port: null, listening: null, service: anchor, services: [scheduledService(NOW, { unit: "reports.weekly", name: "weekly" })] })

  test("the main panel shows its anchor, scheduled, with no gauge and why", () => {
    expect(serviceCard(reports, NOW, "UTC")).toEqual({
      kind: "app",
      title: "Main unit",
      state: { tone: "ok", label: "Scheduled" },
      unit: "reports.service",
      systemd: "active (exited)",
      gauge: null,
      note: "Every service of this project runs on a schedule, listed below. This unit runs nothing: it keeps their timers armed, at boot and after each deployment.",
      facts: [{ label: "Up", value: "3h", detail: "since Jan 15, 09:00 UTC", tone: "neutral" }],
    })
  })

  test("an anchor that is not active stops every timer, and says so", () => {
    const stopped = site({ ...reports, service: { ...anchor, active: "inactive", subState: "dead" } })
    expect(serviceCard(stopped, NOW)).toMatchObject({
      state: { tone: "error", label: "Down" },
      note: "This unit isn't active, so the timers of the project's services are stopped and none of them runs.",
    })
  })

  test("its one service has a row of its own: the main panel describes the anchor", () => {
    expect(serviceRows(reports, NOW).map((row) => row.name)).toEqual(["weekly"])
  })

  test("its state reads Scheduled, never Running nor Down", () => {
    expect(siteState(reports, [])).toEqual({ tone: "ok", label: "Scheduled" })
  })
})

describe("a project that serves no page", () => {
  test("its address says it answers that the project runs in the background", () => {
    const lines = siteAddresses(site({ slug: "courier", address: "courier.test-zone.invalid", headless: true }))
    expect(lines).toEqual([
      {
        name: "courier.test-zone.invalid",
        href: "https://courier.test-zone.invalid",
        role: "preversion",
        state: null,
        detail: "Serves no page: it answers that the project runs in the background",
      },
    ])
  })

  test("its worker, main service, says it has no port", () => {
    const courier = site({
      headless: true,
      port: null,
      listening: null,
      services: [siteService({ name: "queue", unit: "calendar", main: true, kind: "worker", internal: true })],
    })
    const card = serviceCard(courier, NOW)
    expect(card.kind === "app" && card.facts.at(-1)).toEqual({
      label: "Port",
      value: "None",
      detail: "A worker: it runs in the background and listens on nothing",
      tone: "neutral",
    })
    expect(serviceRows(courier, NOW)).toEqual([])
  })
})
