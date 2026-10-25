import { describe, expect, test } from "bun:test"
import { HISTORY_TYPES, historyRequest, historyUrl, matchesType, readHistory, serverAction, sinceStart } from "../src/lib/history"

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)

describe("the History address", () => {
  test("every parameter of the contract, in one order, empty ones left out", () => {
    expect(historyUrl()).toBe("/activity/")
    expect(historyUrl({ target: "cms", type: "secrets" })).toBe("/activity/?target=cms&type=secrets")
    expect(historyUrl({ since: "7d", source: "steward", target: "cms", action: "access", actor: "token:" })).toBe(
      "/activity/?actor=token%3A&action=access&target=cms&source=steward&since=7d",
    )
    expect(historyUrl({ actor: "  ", target: "" })).toBe("/activity/")
  })

  test("reads back what it writes", () => {
    const filter = { actor: "owner", action: "access", target: "cms", source: "portal", type: "signins", since: "2026-10-21" } as const
    expect(readHistory(new URL(historyUrl(filter), "http://page.invalid").searchParams)).toEqual(filter)
  })

  test("drops a source, a type or a since it does not know, rather than narrow to nothing", () => {
    const params = new URLSearchParams("source=nowhere&type=everything&since=yesterday&target=cms")
    expect(readHistory(params)).toEqual({ target: "cms" })
    expect(readHistory(new URLSearchParams("since=2026-02-30"))).toEqual({})
  })

  test("cuts a text field at 200 characters", () => {
    expect(readHistory(new URLSearchParams({ actor: "a".repeat(300) })).actor).toHaveLength(200)
  })
})

describe("types and ranges", () => {
  test("a type gathers its prefixes, any case", () => {
    expect(matchesType("access.add", "access")).toBe(true)
    expect(matchesType("sharing.update", "access")).toBe(true)
    expect(matchesType("Portal.Signin", "signins")).toBe(true)
    expect(matchesType("deploy.success", "access")).toBe(false)
    expect(HISTORY_TYPES.map((type) => type.key)).toEqual(["deployments", "access", "secrets", "signins", "tokens", "backups", "egress"])
  })

  test("a range starts that long ago, a day at its midnight where the reader is", () => {
    expect(sinceStart("24h", NOW)).toBe(NOW - 24 * 3_600_000)
    expect(sinceStart("30d", NOW)).toBe(NOW - 30 * 24 * 3_600_000)
    expect(sinceStart("2026-10-21", NOW)).toBe(new Date(2026, 9, 21).getTime())
    expect(sinceStart("soon", NOW)).toBeNull()
  })
})

describe("a sheet's Recent", () => {
  test("asks the server for what it filters itself", () => {
    const { query, keep } = historyRequest({ target: "cms", source: "steward" }, NOW)
    expect(query).toBe("?source=steward&target=cms&limit=10")
    expect(keep("anything")).toBe(true)
  })

  test("a type of one prefix goes to the server as its action", () => {
    expect(historyRequest({ type: "backups" }, NOW).query).toBe("?action=backup.&limit=10")
  })

  test("a type of several prefixes is narrowed here, from a wider window", () => {
    const { query, keep } = historyRequest({ type: "access", target: "cms" }, NOW)
    expect(query).toBe("?target=cms&limit=100")
    expect(keep("access.remove")).toBe(true)
    expect(keep("deploy.success")).toBe(false)
  })

  test("an action and a type both given: the server takes the action, the page the type", () => {
    const { action, keep } = serverAction({ action: "deploy.", type: "backups" })
    expect(action).toBe("deploy.")
    expect(keep?.("backup.run")).toBe(true)
    expect(keep?.("deploy.success")).toBe(false)
    expect(serverAction({})).toEqual({ action: null, keep: null })
  })

  test("a since becomes the server's from", () => {
    expect(historyRequest({ since: "24h" }, NOW).query).toBe(`?from=${encodeURIComponent(new Date(NOW - 24 * 3_600_000).toISOString())}&limit=10`)
  })
})
