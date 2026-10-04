import { describe, expect, test } from "bun:test"
import {
  DEFAULT_POLICY,
  PEOPLE_MAX,
  PORTAL_TOO_OLD,
  addEntries,
  canShare,
  identityPassed,
  listsInEffect,
  policySummary,
  shareMessage,
  sharingLoadFailure,
  sharingRefusal,
  sitePolicy,
  type SharingList,
} from "../src/lib/sharing"
import { site } from "./factory"

const LIST: SharingList = {
  sso: { configured: true, providerName: "Google", portalUrl: "https://portal.test-zone.invalid", admins: [], allowedDomains: [] },
  sites: [{ host: "kanban.test-zone.invalid", policy: { mode: "people", people: ["alice@acme.test"], domains: [] }, updatedAt: 5 }],
}

describe("the sites that can be shared", () => {
  test("only behind a portal that is in place, the rule of guest access", () => {
    expect(canShare(site({ portal: { wanted: true, installed: true, exemptions: [] } }))).toBe(true)
    expect(canShare(site({ portal: { wanted: true, installed: false, exemptions: [] } }))).toBe(false)
    expect(canShare(site({ portal: { wanted: false, installed: false, exemptions: [] } }))).toBe(false)
  })

  test("whether its app is told who signed in: yes, no, or unknown with an older collector", () => {
    expect(identityPassed(site({ portal: { wanted: true, installed: true, identity: true, exemptions: [] } }))).toBe(true)
    expect(identityPassed(site({ portal: { wanted: true, installed: true, identity: false, exemptions: [] } }))).toBe(false)
    expect(identityPassed(site({ portal: { wanted: true, installed: true, exemptions: [] } }))).toBeNull()
  })

  test("a site never shared gets the narrowest policy", () => {
    expect(sitePolicy(LIST, "kanban.test-zone.invalid")).toEqual({ policy: LIST.sites[0]!.policy, updatedAt: 5 })
    expect(sitePolicy(LIST, "roster.test-zone.invalid")).toEqual({ policy: DEFAULT_POLICY, updatedAt: null })
  })
})

describe("what a mode puts in effect", () => {
  test("admins none, people the people, domain both", () => {
    expect(listsInEffect("admins")).toEqual({ people: false, domains: false })
    expect(listsInEffect("people")).toEqual({ people: true, domains: false })
    expect(listsInEffect("domain")).toEqual({ people: true, domains: true })
  })

  test("the summary says it in a few words", () => {
    expect(policySummary(DEFAULT_POLICY)).toBe("Admins only")
    expect(policySummary({ mode: "admins", people: ["a@acme.test"], domains: ["acme.test"] })).toBe("Admins only")
    expect(policySummary({ mode: "people", people: ["a@acme.test"], domains: [] })).toBe("1 person")
    expect(policySummary({ mode: "people", people: [], domains: [] })).toBe("0 people")
    expect(policySummary({ mode: "domain", people: [], domains: ["acme.test"] })).toBe("acme.test")
    expect(policySummary({ mode: "domain", people: ["a@x.test", "b@x.test"], domains: ["acme.test", "b.test"] })).toBe(
      "2 domains and 2 people",
    )
  })
})

describe("adding to a list", () => {
  test("one address or several, cleaned and sorted, a duplicate simply there", () => {
    expect(addEntries(["bob@acme.test"], "Alice@Acme.test, bob@acme.test carol@acme.test", "people")).toEqual({
      values: ["alice@acme.test", "bob@acme.test", "carol@acme.test"],
      error: null,
    })
  })

  test("one bad entry refuses the whole line and names it, the list unchanged", () => {
    expect(addEntries(["bob@acme.test"], "alice@acme.test, nobody", "people")).toEqual({
      values: ["bob@acme.test"],
      error: '"nobody" isn\'t an email address.',
    })
    expect(addEntries([], "com", "domains").error).toBe('"com" isn\'t a domain, like acme.com.')
  })

  test("an empty line asks for something", () => {
    expect(addEntries([], "  ", "people").error).toBe("Enter an email address.")
    expect(addEntries([], "", "domains").error).toBe("Enter a domain.")
  })

  test("a domain typed with its @ is the domain", () => {
    expect(addEntries([], "@acme.test", "domains")).toEqual({ values: ["acme.test"], error: null })
  })

  test("beyond the portal's bound, refused before the portal refuses it", () => {
    const many = Array.from({ length: PEOPLE_MAX }, (_, i) => `p${i}@acme.test`)
    expect(addEntries(many, "one-more@acme.test", "people").error).toBe(`At most ${PEOPLE_MAX} people.`)
  })
})

describe("what a refusal says", () => {
  test("the known codes, the unreachable, and an unknown code shown as is", () => {
    expect(sharingRefusal(0, null)).toBe("Can't reach the dashboard.")
    expect(sharingRefusal(502, { error: "portal-unreachable" })).toBe("Can't reach the portal.")
    expect(sharingRefusal(400, { error: "no-portal" })).toBe("This site is not behind the portal.")
    expect(sharingRefusal(400, { error: "invalid-people" })).toBe("One of the email addresses is not accepted.")
    expect(sharingRefusal(403, { error: "origin-refused" })).toBe("Origin not allowed.")
    expect(sharingRefusal(418, { error: "teapot" })).toBe("Refused (418: teapot).")
  })
})

describe("when the policies can't be read", () => {
  test("a portal from before sharing says so, rather than unreachable while it answers", () => {
    expect(sharingLoadFailure(404).title).toBe(PORTAL_TOO_OLD)
    expect(sharingLoadFailure(404).advice).toContain("sitesolide deploy --force")
    expect(sharingRefusal(404, null)).toBe(PORTAL_TOO_OLD)
    expect(sharingRefusal(404, { error: "unknown-access" })).toBe("Refused (404: unknown-access).")
  })

  test("the dashboard silent, or the portal down", () => {
    expect(sharingLoadFailure(0).title).toBe("Can't reach the dashboard.")
    expect(sharingLoadFailure(502).title).toBe("Can't reach the portal.")
    expect(sharingLoadFailure(502).advice).toContain("systemctl status portal")
  })
})

describe("the line to send", () => {
  test("where to go and with which account", () => {
    expect(shareMessage("kanban.test-zone.invalid", "Google")).toBe(
      "Open https://kanban.test-zone.invalid and sign in with your Google work account.",
    )
    expect(shareMessage("kanban.test-zone.invalid", null)).toBe("Open https://kanban.test-zone.invalid and sign in with your work account.")
    expect(shareMessage("kanban.test-zone.invalid", "your work account")).toBe(
      "Open https://kanban.test-zone.invalid and sign in with your work account.",
    )
  })
})
