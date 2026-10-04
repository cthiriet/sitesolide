import { describe, expect, test } from "bun:test"
import { activityLine, grantRows, grantWords, refusalField } from "../src/lib/connectors"
import type { ConnectorsView, EgressAuditRow } from "../src/lib/types"

const AT = "2026-10-04T12:00:00.000Z"
const connector = (name: string) => ({ name, baseUrl: `https://${name}.test-zone.invalid`, header: "Authorization", updatedAt: AT, secretUpdatedAt: AT, updatedBy: "owner" })
const grant = (slug: string, name: string) => ({ slug, connector: name, at: AT, by: "owner" })

const VIEW: Pick<ConnectorsView, "connectors" | "grants" | "requests" | "sites"> = {
  connectors: [connector("chat"), connector("code")],
  grants: [grant("shop", "chat"), grant("notes", "code"), grant("gone", "chat")],
  requests: [
    { slug: "shop", connectors: ["chat", "code"] },
    { slug: "blog", connectors: ["mail"] },
  ],
  sites: ["blog", "notes", "shop"],
}

describe("the grants", () => {
  test("every pair that matters, what needs a decision first", () => {
    expect(grantRows(VIEW).map((row) => [row.state, row.slug, row.connector])).toEqual([
      ["gone", "gone", "chat"],
      ["asked", "shop", "code"],
      ["missing", "blog", "mail"],
      ["granted", "shop", "chat"],
      ["unasked", "notes", "code"],
    ])
  })

  test("each state says what it means and offers what can be done", () => {
    const words = Object.fromEntries(grantRows(VIEW).map((row) => [row.state, grantWords(row)]))
    expect(words.granted).toMatchObject({ word: "Granted", tone: "ok", action: "withdraw" })
    expect(words.asked).toMatchObject({ word: "Asked, not granted", tone: "attention", action: "grant" })
    expect(words.missing).toMatchObject({ word: "No such connector", action: null })
    expect(words.unasked).toMatchObject({ tone: "neutral", action: "withdraw" })
    expect(words.gone).toMatchObject({ word: "Site removed", tone: "error", action: "withdraw" })
    expect(words.gone!.help).toContain("before the name is reused")
  })

  test("nothing asked, nothing granted: no row", () => {
    expect(grantRows({ connectors: [connector("chat")], grants: [], requests: [], sites: ["shop"] })).toEqual([])
  })
})

describe("the egress activity in words", () => {
  const row = (action: string, target: string | null, detail: unknown, actor = "system"): EgressAuditRow => ({
    id: 1,
    at: AT,
    actor,
    action,
    target,
    detail: detail === null ? null : JSON.stringify(detail),
  })

  test("a refusal names the destination, the reason and how often", () => {
    expect(activityLine(row("egress.denied", "shop", { destination: "evil.test-zone.invalid:443", reason: "not in the list", count: 3 }))).toMatchObject({
      summary: "Refused evil.test-zone.invalid:443",
      site: "shop",
      detail: "not in the list, 3 times",
      tone: "attention",
      at: Date.parse(AT),
    })
    expect(activityLine(row("egress.denied", null, { destination: "connector:chat", reason: "not a project", count: 1, account: "root" }))).toMatchObject({
      summary: "Refused connector chat",
      detail: "not a project, from the account root",
    })
    expect(activityLine(row("egress.denied", null, { reason: "rate limited", pairs: 12, count: 40 })).summary).toBe("More refusals than the audit keeps")
  })

  test("a connector's use, its changes and its grants", () => {
    expect(activityLine(row("connector.use", "shop", { connector: "chat", count: 12, failures: 2 }))).toMatchObject({
      summary: "Used chat",
      detail: "12 calls, 2 failed",
      tone: "attention",
    })
    expect(activityLine(row("connector.update", "chat", { change: "created" }, "owner"))).toMatchObject({ summary: "Added connector chat", detail: "by owner" })
    expect(activityLine(row("connector.update", "chat", { change: "updated", changed: ["baseUrl"], valueReplaced: true }, "owner")).detail).toBe(
      "base address, value replaced, by owner",
    )
    expect(activityLine(row("connector.update", "chat", { change: "removed" }, "owner")).summary).toBe("Removed connector chat")
    expect(activityLine(row("connector.grant", "shop", { connector: "chat", granted: true }, "owner"))).toMatchObject({ summary: "Granted chat", site: "shop" })
    expect(activityLine(row("connector.grant", "shop", { connector: "chat", granted: false }, "owner")).summary).toBe("Withdrew chat")
  })

  test("an unknown action, an unreadable detail or date do not bring the page down", () => {
    expect(activityLine(row("egress.something", "shop", null))).toMatchObject({ summary: "egress.something", site: "shop" })
    expect(activityLine({ ...row("connector.use", "shop", null), detail: "{not json" }).summary).toBe("Used a connector")
    expect(activityLine({ ...row("connector.use", "shop", null), at: "yesterday" }).at).toBeNull()
  })
})

describe("a refusal's field", () => {
  test("read from the steward's prefix, the rest shown under the field", () => {
    expect(refusalField("base address: must be https://, a host name")).toEqual({ field: "baseUrl", message: "Must be https://, a host name" })
    expect(refusalField("value: required to create a connector")).toEqual({ field: "value", message: "Required to create a connector" })
    expect(refusalField("header: Host frames the request, the proxy sets it")).toMatchObject({ field: "header" })
    expect(refusalField("name: a letter, then...")).toMatchObject({ field: "name" })
    expect(refusalField("the connectors are not managed here: x")).toEqual({ field: null, message: "the connectors are not managed here: x" })
  })
})
