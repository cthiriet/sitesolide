import { describe, expect, test } from "bun:test"
import {
  passwordAnnouncement,
  passwordKind,
  passwordToSend,
  firstFaultyField,
  passwordTexts,
  checkEntry,
  BREAK_GLASS,
  breakGlassLine,
  isOwnerPassword,
  offersPasswordChange,
} from "../src/lib/password"

describe("what the change says", () => {
  test("the dashboard, the portal, and any other service", () => {
    expect(passwordKind("dashboard")).toBe("dashboard")
    expect(passwordKind("portal")).toBe("portal")
    expect(passwordKind("cms")).toBe("other")
  })

  test("the dashboard: unlocking changes at once, sign-in on the restart, which closes the sessions", () => {
    const texts = passwordTexts("dashboard", "PASSWORD_HASH")
    expect(texts.title).toBe("Change the dashboard password")
    expect(texts.warning).toContain("right away")
    expect(texts.warning).toContain("until the dashboard restarts")
    expect(texts.warning).toContain("signs everyone out")
  })

  test("the portal: every personal site asks for it after its restart", () => {
    const texts = passwordTexts("portal", "PASSWORD_HASH")
    expect(texts.title).toBe("Change the portal password")
    expect(texts.warning).toContain("Every personal site")
    expect(texts.warning).toContain("once the portal restarts")
  })

  test("another service names its variable", () => {
    expect(passwordTexts("cms", "ADMIN_HASH").title).toBe("Change ADMIN_HASH")
  })
})

describe("input", () => {
  const base = { dashboard: "demo", mode: "draw" as const, newPassword: "", confirmation: "" }

  test("the dashboard password is always retyped", () => {
    expect(checkEntry({ ...base, dashboard: "" })).toEqual({ dashboard: "Enter your dashboard password." })
    expect(checkEntry(base)).toEqual({})
  })

  test("drawn by the steward: nothing else to type, and nothing is sent", () => {
    expect(checkEntry({ ...base, newPassword: "ignore", confirmation: "different" })).toEqual({})
    expect(passwordToSend({ mode: "draw", newPassword: "ignore" })).toBeNull()
  })

  test("chosen: two identical entries, without judging the strength, which the steward judges", () => {
    const selected = { ...base, mode: "choose" as const }
    expect(checkEntry({ ...selected, newPassword: "" })).toEqual({ newPassword: "Enter the new password." })
    expect(checkEntry({ ...selected, newPassword: "abc", confirmation: "abd" })).toEqual({
      confirmation: "The two passwords don't match.",
    })
    expect(checkEntry({ ...selected, newPassword: "a", confirmation: "a" })).toEqual({})
    expect(checkEntry({ ...selected, newPassword: "abc ", confirmation: "abc" })).toEqual({
      confirmation: "The two passwords don't match.",
    })
    expect(passwordToSend({ mode: "choose", newPassword: " spaces kept " })).toBe(" spaces kept ")
  })

  test("focus goes to the first faulty field, in form order", () => {
    expect(firstFaultyField({ confirmation: "x", dashboard: "y" })).toBe("dashboard")
    expect(firstFaultyField({ confirmation: "x" })).toBe("confirmation")
    expect(firstFaultyField({})).toBeNull()
  })
})

describe("once the owner holds a passkey", () => {
  const base = { dashboard: "", mode: "draw" as const, newPassword: "", confirmation: "" }

  test("no dashboard password is asked for: the passkey confirms, the new password is checked as before", () => {
    expect(checkEntry(base, true)).toEqual({})
    expect(checkEntry(base, false)).toEqual({ dashboard: "Enter your dashboard password." })
    expect(checkEntry({ ...base, mode: "choose", newPassword: "abc", confirmation: "abd" }, true)).toEqual({ confirmation: "The two passwords don't match." })
  })

  test("the owner's two passwords are no longer offered for a change, any other project's still is", () => {
    const dashboard = { slug: "dashboard", file: "dashboard.env", variable: "PASSWORD_HASH" }
    const portal = { slug: "portal", file: "portal.env", variable: "PASSWORD_HASH" }
    const other = { slug: "cms", file: "env", variable: "ADMIN_HASH" }
    // A hash of the dashboard's that is not its sign-in's: the monitor's, for instance.
    const monitor = { slug: "dashboard", file: "dashboard-monitor.env", variable: "PASSWORD_HASH" }
    expect([dashboard, portal, other, monitor].map(isOwnerPassword)).toEqual([true, true, false, false])
    expect([dashboard, portal, other, monitor].map((target) => offersPasswordChange(target, true))).toEqual([false, false, true, true])
    expect([dashboard, portal, other, monitor].map((target) => offersPasswordChange(target, false))).toEqual([true, true, true, true])
  })

  test("what the page says in their place names the way back", () => {
    expect(BREAK_GLASS).toContain("passkey")
    expect(BREAK_GLASS).toContain("sitesolide passkey remove")
    expect(breakGlassLine("portal")).toContain("The portal password works again")
  })
})

describe("drawn password", () => {
  test("the announcement never contains the password", () => {
    expect(passwordAnnouncement(true)).toBe("Password changed. Copy it now: it won't be shown again.")
    expect(passwordAnnouncement(false)).toBe("Password changed.")
  })
})
