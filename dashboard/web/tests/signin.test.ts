import { describe, expect, test } from "bun:test"
import { waitMessage, copyShortcut, signInRefusal } from "../src/lib/signin"

describe("sign-in refusal", () => {
  test("a wrong password is stated with nothing added", () => {
    expect(signInRefusal(401, { error: "refused" })).toEqual({ message: "Wrong password.", waitS: 0 })
  })

  test("rate limiting returns its wait, rounded up and never zero", () => {
    expect(signInRefusal(429, { error: "too-many-attempts", wait: 42 })).toEqual({
      message: "Too many attempts.",
      waitS: 42,
    })
    expect(signInRefusal(429, { wait: 0.2 }).waitS).toBe(1)
    expect(signInRefusal(429, null).waitS).toBe(1)
  })

  test("a refused origin and a downed network each have their message", () => {
    expect(signInRefusal(403, { error: "origin-refused" }).message).toBe("Origin not allowed.")
    expect(signInRefusal(0, null).message).toContain("Can't reach the dashboard")
  })

  test("an unexpected status is shown", () => {
    expect(signInRefusal(500, null).message).toBe("Sign-in failed (500).")
  })

  test("the countdown is stated as a compact duration, never going below zero", () => {
    expect(waitMessage(42)).toBe("Try again in 42s")
    expect(waitMessage(1800)).toBe("Try again in 30m")
    expect(waitMessage(-3)).toBe("Try again in 0s")
  })
})

describe("copy shortcut", () => {
  test("Cmd on Mac and iOS, Ctrl elsewhere", () => {
    expect(copyShortcut("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Cmd+C")
    expect(copyShortcut("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("Cmd+C")
    expect(copyShortcut("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl+C")
  })
})
