import { describe, expect, test } from "bun:test"
import { MEMORY_CRITICAL_SHARE, PEAK_WARNING_SHARE } from "../src/lib/gauges"
import {
  SERVICE_THRESHOLD_POSITIONS,
  siteAddresses,
  siteFolder,
  siteDiscrepancies,
  siteState,
  serviceCard,
  readAccess,
  siteStorage,
} from "../src/lib/site-card"
import { discrepancy, service, site } from "./factory"

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
      state: { tone: "ok", label: "Running" },
      unit: "cms.service",
      systemd: "active (running)",
      gauge: {
        tile: { heading: "Memory", percent: 77, value: "198 MB", detail: "of 256 MB", level: "warn" },
        peak: 86,
        peakDetail: "Peak 221 MB, 86% of the limit",
      },
      facts: [
        { label: "Up", value: "20h", detail: "since Jan 14, 16:00", tone: "neutral" },
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
      state: { tone: "error", label: "Restarting" },
      unit: "calendar.service",
      systemd: "activating (auto-restart)",
      gauge: null,
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
      state: { tone: "error", label: "Down" },
      unit: null,
      systemd: null,
      gauge: null,
      facts: [{ label: "Port", value: "3040", detail: "Nothing listens on it", tone: "error" }],
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

  test("with no gate: no check, and what that means depending on the type", () => {
    expect(readAccess(site())).toMatchObject({ title: "No gate", tone: "neutral", checks: [] })
    expect(readAccess(site()).detail).toContain("the app handles its own sign-in")
    expect(readAccess(site({ type: "static" })).detail).toContain("anyone with the address")
  })

  test("the portal, requested and applied", () => {
    expect(readAccess(site({ portal: portal(true, true, ["/api/*"]) }))).toMatchObject({
      access: { kind: "portal", exemptions: ["/api/*"] },
      title: "Portal",
      tone: "neutral",
      checks: [{ door: "Portal", requested: "Requested", applied: "In the live Caddy block", tone: "ok" }],
    })
  })

  test("the preview lock, requested and its code in effect", () => {
    expect(readAccess(site({ lock: lock(true, "K7PX3M") }))).toMatchObject({
      access: { kind: "code", code: "K7PX3M" },
      title: "Preview lock",
      checks: [{ door: "Preview lock", requested: "Requested", applied: "Code in effect", tone: "ok" }],
    })
  })

  /** The worst state: the manifest says closed, Caddy serves in the clear. The check shows which side. */
  test("a disagreement reads as an error, with the side that is missing", () => {
    const expose = readAccess(site({ portal: portal(true, false) }))
    expect(expose).toMatchObject({ title: "Portal not applied: served unprotected", tone: "error" })
    expect(expose.detail).toContain("anyone can reach the site")
    expect(expose.checks).toEqual([
      { door: "Portal", requested: "Requested", applied: "Missing from the live Caddy block", tone: "error" },
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
      { label: "Deployed", value: "20h ago", detail: "Jan 14, 16:00", tone: "neutral" },
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
