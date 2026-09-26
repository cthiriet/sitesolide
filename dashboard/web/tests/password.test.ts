import { describe, expect, test } from "bun:test"
import {
  passwordAnnouncement,
  passwordKind,
  passwordToSend,
  firstFaultyField,
  generatedPasswordText,
  passwordTexts,
  checkEntry,
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

describe("drawn password", () => {
  test("the copy is the password as it is, with no blank and no line break", () => {
    expect(generatedPasswordText("x7Kp-2mQa-9vRt")).toBe("x7Kp-2mQa-9vRt")
    expect(generatedPasswordText(" a b ")).toBe(" a b ")
  })

  test("the announcement never contains the password", () => {
    expect(passwordAnnouncement(true)).toBe("Password changed. Copy it now: it won't be shown again.")
    expect(passwordAnnouncement(false)).toBe("Password changed.")
  })
})
