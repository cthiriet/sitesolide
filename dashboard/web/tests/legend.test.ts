import { describe, expect, test } from "bun:test"
import { ACCESS_KEYS, ACCESS_WORDS, EXEMPT_LINE, KINDS, KIND_WORDS, accessKey, accessLines, siteKind } from "../src/lib/legend"
import { siteAccess } from "../src/lib/sites"
import { site, siteService } from "./factory"

describe("a project's kind", () => {
  test("static, app, or no manifest, from its type", () => {
    expect(siteKind(site({ type: "static", service: null }))).toBe("static")
    expect(siteKind(site())).toBe("app")
    expect(siteKind(site({ type: "no-manifest", service: null }))).toBe("none")
  })

  test("a project that serves no page is Background, unless every service is scheduled", () => {
    const worker = siteService({ name: "worker", kind: "worker", main: true })
    const hourly = siteService({ name: "hourly", kind: "scheduled", main: false })
    expect(siteKind(site({ headless: true, services: [worker, hourly] }))).toBe("background")
    expect(siteKind(site({ headless: true, services: [hourly] }))).toBe("scheduled")
  })

  test("every kind has its words, in the facet's order", () => {
    expect(KINDS).toEqual(["static", "app", "background", "scheduled", "none"])
    for (const kind of KINDS) expect(KIND_WORDS[kind].description.endsWith(".")).toBe(true)
  })
})

describe("a general access as an icon", () => {
  test("the three ways and the disagreement", () => {
    expect(accessKey(siteAccess(site()))).toBe("public")
    expect(accessKey(siteAccess(site({ portal: { wanted: true, installed: true, exemptions: [] } })))).toBe("restricted")
    expect(accessKey(siteAccess(site({ lock: { closed: true, code: "K7Q2", url: null } })))).toBe("code")
    expect(accessKey(siteAccess(site({ portal: { wanted: true, installed: false, exemptions: [] } })))).toBe("mismatch")
    expect(ACCESS_KEYS.map((key) => ACCESS_WORDS[key].facet)).toEqual(["Public", "Restricted", "Anyone with the code", "Mismatch"])
  })

  test("the tooltip names what the row leaves out of sight", () => {
    const exempt = siteAccess(site({ portal: { wanted: true, installed: true, exemptions: ["/api/webhooks/*", "/health"] } }))
    expect(accessLines(exempt)).toEqual(["Restricted", ACCESS_WORDS.restricted.description, `${EXEMPT_LINE}: /api/webhooks/*, /health`])
    expect(accessLines(siteAccess(site({ lock: { closed: true, code: "K7Q2", url: null } })))).toEqual(["Anyone with the code", "Code: K7Q2"])
    expect(accessLines({ kind: "code", code: null, url: null }, "cms")).toEqual(["Anyone with the code", "An Admin of cms, or the owner, has the code."])
    expect(accessLines(siteAccess(site({ portal: { wanted: true, installed: false, exemptions: [] } })))).toEqual([
      "Access mismatch",
      "Restricted in sitesolide.json, public on the server",
    ])
  })
})
