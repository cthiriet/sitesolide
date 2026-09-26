import { describe, expect, test } from "bun:test"
import {
  PORTAL_SCALE_MS,
  PORTAL_SLOW_MS,
  portalActions,
  portalProgress,
  lockCommands,
  removalConfirmation,
  confirmationValid,
  gatekeeperSteps,
  readPortal,
  portalFromSnapshot,
  toggleTexts,
} from "../src/lib/access"
import { portalView, site } from "./factory"

describe("portal state", () => {
  test("applied and requested: live, closed by the portal", () => {
    const read = readPortal(portalView({ requested: true, installed: true }), "cms")
    expect(read).toMatchObject({ tone: "ok", title: "Portal on", requested: "Requested", checkTone: "ok", guards: true })
    expect(read.detail).toContain("cms")
  })

  test("neither applied nor requested: open, without judgement", () => {
    expect(readPortal(portalView(), "wheels")).toMatchObject({
      tone: "neutral",
      title: "Portal off",
      requested: "Not requested",
      applied: "Not in the live Caddy block",
      checkTone: "neutral",
      guards: false,
    })
  })

  test("a disagreement is an error on both sides, and the portal still keeps its public paths", () => {
    const requested = readPortal(portalView({ requested: true, installed: false }), "cms")
    expect(requested).toMatchObject({
      tone: "error",
      title: "Portal requested but not applied",
      checkTone: "error",
      guards: true,
    })
    expect(requested.detail).toContain("anyone can reach")
    const pose = readPortal(portalView({ requested: false, installed: true }), "cms")
    expect(pose).toMatchObject({
      tone: "error",
      title: "Portal applied but not requested",
      checkTone: "error",
      guards: true,
    })
  })

  test("without the steward, the snapshot gives the state but no action", () => {
    const view = portalFromSnapshot(site({ portal: { wanted: true, installed: true, exemptions: ["/api/*"] } }))
    expect(view).toEqual({ requested: true, installed: true, modifiable: false, reason: null })
    expect(portalActions(view)).toEqual([])
  })
})

describe("offered actions", () => {
  test("none without the steward's agreement, whatever the state", () => {
    for (const requested of [true, false]) {
      for (const installed of [true, false]) {
        expect(
          portalActions(
            portalView({ requested, installed, modifiable: false, reason: "The portal can't sit behind itself." }),
          ),
        ).toEqual([])
      }
    }
  })

  test("applied: turn it off; absent: turn it on", () => {
    expect(portalActions(portalView({ requested: true, installed: true }))).toEqual([
      { active: false, label: "Turn off portal", main: true },
    ])
    expect(portalActions(portalView())).toEqual([{ active: true, label: "Turn on portal", main: true }])
  })

  test("in disagreement, both, turning it on first: it closes the site", () => {
    for (const portal of [
      portalView({ requested: true, installed: false }),
      portalView({ requested: false, installed: true }),
    ]) {
      expect(portalActions(portal)).toEqual([
        { active: true, label: "Turn on portal", main: true },
        { active: false, label: "Turn off portal", main: false },
      ])
    }
  })

  test("the removal requires the slug retyped, without the blanks of an entry", () => {
    expect(confirmationValid("cms", "cms")).toBe(true)
    expect(confirmationValid("  cms ", "cms")).toBe(true)
    expect(removalConfirmation("  cms ")).toBe("cms")
    expect(confirmationValid("CMS", "cms")).toBe(false)
    expect(confirmationValid("cr", "cms")).toBe(false)
    expect(confirmationValid("", "cms")).toBe(false)
    expect(confirmationValid("test-zone.invalid", "test-zone.invalid")).toBe(true)
  })

  test("an action's words name it, and the removal's say that the site becomes public", () => {
    const pose = toggleTexts("cms", true)
    expect(pose).toMatchObject({
      action: "Turn on portal",
      title: "Turn on the portal for cms?",
      succeeded: "The portal is on for cms",
    })
    const removal = toggleTexts("cms", false)
    expect(removal).toMatchObject({ action: "Turn off portal", failure: "Couldn't turn off the portal for cms" })
    expect(removal.consequence).toContain("stops guarding cms")
    expect(gatekeeperSteps("cms")).toHaveLength(3)
    expect(gatekeeperSteps("cms").at(-1)).toContain("cms")
  })
})

describe("waiting for the gatekeeper", () => {
  test("the time elapsed on the track, never beyond it nor below it", () => {
    expect(PORTAL_SLOW_MS).toBeLessThan(PORTAL_SCALE_MS)
    expect(portalProgress(0)).toEqual({ part: 0, elapsed: "0s", slow: false })
    expect(portalProgress(PORTAL_SLOW_MS - 1)).toMatchObject({ slow: false, elapsed: "29s" })
    expect(portalProgress(PORTAL_SLOW_MS)).toMatchObject({ slow: true, elapsed: "30s" })
    expect(portalProgress(10 * PORTAL_SCALE_MS)).toMatchObject({ part: 1 })
    expect(portalProgress(-1000)).toMatchObject({ part: 0, elapsed: "0s" })
  })

  /**
   * The track promises a result before its end: it has to cover the longest
   * answer the relay waits for. The page cannot import the value, so the test
   * reads it back from the protocol.
   */
  test("the track covers the longest gatekeeper answer the relay waits for", async () => {
    const protocol = await Bun.file(new URL("../../src/secrets/protocol.ts", import.meta.url)).text()
    const found = /export const MAX_PORTAL_MS = ([\d_]+)/.exec(protocol)
    expect(found).not.toBeNull()
    expect(PORTAL_SCALE_MS).toBeGreaterThanOrEqual(Number((found?.[1] ?? "").replaceAll("_", "")))
  })
})

describe("preview lock", () => {
  test("absent: set it; set: change the code or remove it, always from the workstation", () => {
    expect(lockCommands("bakery-martin", false)).toEqual([
      { label: "Set a preview lock", command: "bin/lock.sh enable bakery-martin" },
    ])
    expect(lockCommands("bakery-martin", true).map((command) => command.command)).toEqual([
      "bin/lock.sh code bakery-martin",
      "bin/lock.sh disable bakery-martin",
    ])
  })

  test("the commands are the ones bin/lock.sh documents", async () => {
    const script = await Bun.file(new URL("../../../bin/lock.sh", import.meta.url)).text()
    for (const verb of ["enable", "code", "disable"]) expect(script).toContain(`bin/lock.sh ${verb} <slug>`)
  })
})
