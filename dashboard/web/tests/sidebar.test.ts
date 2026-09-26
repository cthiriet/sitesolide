import { describe, expect, test } from "bun:test"
import {
  SIDEBAR_KEY,
  machineIndicators,
  siteIndicators,
  readCollapsed,
  storeCollapsed,
  sidebarShortcut,
  downServices,
} from "../src/lib/sidebar"
import { discrepancy, secretFile, guest, portalView, secretProject, service, secretService, site } from "./factory"

const NOW = 1_800_000_000_000
const HOUR = 3600_000

function storage(values: Record<string, string> = {}) {
  const table = new Map(Object.entries(values))
  return {
    table,
    getItem: (key: string) => table.get(key) ?? null,
    setItem: (key: string, value: string) => void table.set(key, value),
    removeItem: (key: string) => void table.delete(key),
  }
}

function blocked(): never {
  throw new Error("SecurityError: The operation is insecure.")
}

describe("remembered collapse", () => {
  test("only \"1\" collapses the sidebar", () => {
    expect(readCollapsed(() => storage({ [SIDEBAR_KEY]: "1" }))).toBe(true)
    for (const value of ["0", "true", "", " 1", "collapsed"]) {
      expect(readCollapsed(() => storage({ [SIDEBAR_KEY]: value }))).toBe(false)
    }
    expect(readCollapsed(() => storage())).toBe(false)
  })

  test("collapsing writes the key, expanding clears it", () => {
    const memory = storage()
    expect(storeCollapsed(() => memory, true)).toBe(true)
    expect(memory.table.get(SIDEBAR_KEY)).toBe("1")
    expect(readCollapsed(() => memory)).toBe(true)
    expect(storeCollapsed(() => memory, false)).toBe(true)
    expect(memory.table.has(SIDEBAR_KEY)).toBe(false)
  })

  test("a storage that throws leaves the sidebar expanded, and breaks nothing", () => {
    expect(readCollapsed(blocked)).toBe(false)
    expect(storeCollapsed(blocked, true)).toBe(false)
  })
})

/**
 * The inline script in main.astro reads the collapsed state back before the
 * first render, so that the sidebar's column already has its width. It cannot
 * import lib/sidebar.ts: it is run here against the same values.
 */
describe("inline script in main.astro", async () => {
  const template = await Bun.file(new URL("../src/layouts/main.astro", import.meta.url)).text()
  const scripts = [...template.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map((found) => found[1] ?? "")
  const script = scripts.find((content) => content.includes(SIDEBAR_KEY)) ?? ""

  function openWith(value: string | null, storageBlocked = false) {
    const attributes = new Map<string, string>()
    const browserWindow = {
      get localStorage() {
        if (storageBlocked) blocked()
        return storage(value === null ? {} : { [SIDEBAR_KEY]: value })
      },
    }
    const document = { documentElement: { setAttribute: (name: string, val: string) => void attributes.set(name, val) } }
    new Function("window", "document", script)(browserWindow, document)
    return attributes.get("data-sidebar-collapsed") ?? null
  }

  test("the script is found, and comes after the theme one", () => {
    expect(script).toContain("try")
    expect(scripts[0]).toContain("prefers-color-scheme")
    expect(scripts.indexOf(script)).toBeGreaterThan(0)
  })

  test("it decides like readCollapsed, for every value", () => {
    for (const value of [null, "1", "0", "true", "", " 1"]) {
      const expected = readCollapsed(() => storage(value === null ? {} : { [SIDEBAR_KEY]: value }))
      expect({ value, collapsed: openWith(value) === "1" }).toEqual({ value, collapsed: expected })
    }
  })

  test("a blocked storage leaves the sidebar expanded", () => {
    expect(openWith("1", true)).toBeNull()
  })

  test("the collapsed width really is the one from global.css", async () => {
    const css = await Bun.file(new URL("../src/styles/global.css", import.meta.url)).text()
    expect(css).toContain(':root[data-sidebar-collapsed="1"]')
  })
})

describe("the machine's indicators", () => {
  test("before any data, and with no discrepancy, nothing is shown", () => {
    expect(machineIndicators(null)).toEqual({ home: null, activity: null })
    expect(machineIndicators([])).toEqual({ home: null, activity: null })
  })

  test("the discrepancies: in error if there is one, in attention otherwise; the activity reports nothing", () => {
    expect(machineIndicators([discrepancy("warning"), discrepancy("error")])).toEqual({
      home: { count: 2, tone: "error", label: "2 issues" },
      activity: null,
    })
    expect(machineIndicators([discrepancy("warning")]).home).toEqual({ count: 1, tone: "attention", label: "1 refusal" })
  })

  test("the downed services: an app stopped or with no unit, never a static site", () => {
    const sites = [
      site({ slug: "a" }),
      site({ slug: "b", service: service({ active: "failed" }) }),
      site({ slug: "c", service: null }),
      site({ slug: "d", type: "static", service: null }),
    ]
    expect(downServices(sites, NOW)).toBe(2)
  })
})

describe("a site's indicators", () => {
  const empty = { discrepancies: null, project: null, site: null, guests: null, now: NOW, serverNow: NOW }
  const nothing = { overview: null, audience: null, secrets: null, guests: null, access: null }

  test("before any data, and when all is well, nothing is shown", () => {
    expect(siteIndicators(empty)).toEqual(nothing)
    expect(siteIndicators({ ...empty, discrepancies: [], project: secretProject(), site: site(), guests: [] })).toEqual(nothing)
  })

  test("Overview counts the site's discrepancies, at the worst one's tone", () => {
    expect(siteIndicators({ ...empty, discrepancies: [discrepancy("warning"), discrepancy("error")] }).overview).toEqual({
      count: 2,
      tone: "error",
      label: "2 issues",
    })
  })

  test("Secrets counts what its files ask for, without the service Overview already shows", () => {
    const project = secretProject({
      service: secretService({ state: "failed", subState: "failed" }),
      files: [
        secretFile({ restartPending: true }),
        secretFile({ name: "cms-smtp.env", state: "absent", variables: [] }),
      ],
    })
    expect(siteIndicators({ ...empty, project }).secrets).toEqual({ count: 2, tone: "error", label: "missing, restart pending" })
    const wait = secretProject({ files: [secretFile({ restartPending: true })] })
    expect(siteIndicators({ ...empty, project: wait }).secrets).toEqual({ count: 1, tone: "attention", label: "restart pending" })
    expect(siteIndicators({ ...empty, project: secretProject({ service: secretService({ state: "failed", subState: "failed" }) }) }).secrets).toBeNull()
  })

  test("Guests counts the active accesses, without the expired ones, in neutral", () => {
    const guests = [
      guest({ id: "a", expiresAt: null }),
      guest({ id: "b", expiresAt: NOW + HOUR }),
      guest({ id: "c", expiresAt: NOW - HOUR }),
    ]
    expect(siteIndicators({ ...empty, guests }).guests).toEqual({ count: 2, tone: "neutral", label: "2 active guests" })
  })

  test("Access reports a door in disagreement, seen from the steward or from the snapshot", () => {
    const disagreement = { count: 1, tone: "error", label: "the gate disagrees with sitesolide.json" }
    const requested = secretProject({ portal: portalView({ requested: true, installed: false }) })
    expect(siteIndicators({ ...empty, project: requested }).access).toEqual(disagreement)
    const agreed = secretProject({ portal: portalView({ requested: true, installed: true }) })
    expect(siteIndicators({ ...empty, project: agreed }).access).toBeNull()
    const lock = site({ lock: { closed: true, code: null, url: null } })
    expect(siteIndicators({ ...empty, site: lock }).access).toEqual(disagreement)
  })
})

describe("collapse shortcut", () => {
  test("Cmd on a Mac, Ctrl elsewhere", () => {
    expect(sidebarShortcut("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("⌘B")
    expect(sidebarShortcut("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl+B")
  })
})
