import { describe, expect, test } from "bun:test"
import {
  accessExpiry,
  createFieldError,
  createRefusal,
  domainGroups,
  entryMatches,
  entryProjects,
  expiredAccesses,
  mayGetCreate,
  mayRemove,
  peopleEntries,
  personKind,
  projectRoles,
  removalSentence,
  revokedTokensLine,
} from "../src/lib/people"
import type { SignIn } from "../src/lib/access"

const NOW = 1_791_000_000_000
const HOUR = 3600_000
const SIGN_IN: SignIn = { configured: true, allowedDomains: ["acme.test"], admins: [], providerName: "Google" }

describe("the People page", () => {
  test("a person's roles across projects, by project, a password access with its expiry", () => {
    const roles = projectRoles({ roles: { shop: "visitor", blog: "developer" }, passwords: [{ slug: "shop", expiresAt: NOW + 5 * HOUR, expired: false }] }, NOW)
    expect(roles).toEqual([
      { slug: "blog", role: "developer", label: "Developer", password: null },
      { slug: "shop", role: "visitor", label: "Password access", password: { text: "expires in 5h", tone: "attention" } },
    ])
  })

  test("removed from every project only when they hold something; the create right for a company account alone", () => {
    expect(mayRemove({ roles: {}, create: false })).toBe(false)
    expect(mayRemove({ roles: {}, create: true })).toBe(true)
    expect(mayRemove({ roles: { blog: "visitor" }, create: false })).toBe(true)
    expect(mayGetCreate("bob@acme.test", SIGN_IN)).toBe(true)
    expect(mayGetCreate("Example Accounting", SIGN_IN)).toBe(false)
    expect(createRefusal("eve@gmail.test", SIGN_IN)).toBe("Only someone with a company account can create projects.")
    expect(createRefusal("bob@acme.test", { ...SIGN_IN, configured: false })).toContain("Company sign-in isn't set up")
  })

  test("the field that gives the right to someone new refuses what it can see before sending", () => {
    expect(createFieldError("bob", SIGN_IN)).toContain("company email")
    expect(createFieldError("eve@gmail.test", SIGN_IN)).toContain("company account")
    expect(createFieldError(" Bob@acme.test ", SIGN_IN)).toBeNull()
  })

  test("domains, each once with the projects it opens", () => {
    expect(domainGroups([{ slug: "shop", domain: "@acme.test" }, { slug: "blog", domain: "@acme.test" }, { slug: "cms", domain: "@beta.test" }])).toEqual([
      { domain: "@acme.test", slugs: ["blog", "shop"] },
      { domain: "@beta.test", slugs: ["cms"] },
    ])
  })

  test("the password accesses that ended, across projects, for Remove expired", () => {
    const people = [
      { who: "Example Accounting", passwords: [{ slug: "cms", expiresAt: NOW - HOUR, expired: true }, { slug: "shop", expiresAt: null, expired: false }] },
      { who: "eve@out.test", passwords: [{ slug: "blog", expiresAt: NOW - 1, expired: false }] },
      { who: "bob@acme.test", passwords: [] },
    ]
    expect(expiredAccesses(people, NOW)).toEqual([
      { slug: "blog", who: "eve@out.test" },
      { slug: "cms", who: "Example Accounting" },
    ])
  })

  test("removing someone from every project says which tokens go with them, and who made each", () => {
    const token = (label: string, fields: Partial<{ member: string | null; by: string; revokedAt: number | null; expiresAt: number | null }> = {}) => ({
      label,
      member: "alice@acme.test",
      by: "owner",
      revokedAt: null,
      expiresAt: null,
      ...fields,
    })
    const tokens = [
      token("Alice's laptop"),
      token("alice-ci", { by: "alice@acme.test" }),
      token("old", { revokedAt: NOW - HOUR }),
      token("lapsed", { expiresAt: NOW - HOUR }),
      token("bob's", { member: "bob@acme.test" }),
      token("agent", { member: null }),
    ]
    expect(revokedTokensLine(tokens, "alice@acme.test", NOW)).toBe("Also revokes 2 tokens: Alice's laptop (made by you), alice-ci (made by them).")
    expect(revokedTokensLine(tokens, "bob@acme.test", NOW)).toBe("Also revokes 1 token: bob's (made by you).")
    expect(revokedTokensLine(tokens, "carol@acme.test", NOW)).toBeNull()
  })
})

describe("removing someone from every project", () => {
  test("says the create right only when they held it, and the dashboard only when they signed in to it", () => {
    expect(removalSentence({ roles: { cms: "developer" }, create: true, passwords: [] })).toBe(
      "They lose every role at their next request, may no longer create projects, and are signed out of the dashboard.",
    )
    expect(removalSentence({ roles: { cms: "developer" }, create: false, passwords: [] })).toBe("They lose every role at their next request, and are signed out of the dashboard.")
    expect(removalSentence({ roles: { cms: "visitor" }, create: false, passwords: [{ slug: "cms", expiresAt: null, expired: false }] })).toBe(
      "They lose every role and password access at their next request.",
    )
    expect(removalSentence(null)).toBe("")
  })
})

describe("one list of people, password access and domains", () => {
  const person = (who: string, partial: Partial<{ roles: Record<string, "visitor" | "viewer" | "developer" | "admin">; create: boolean; passwords: { slug: string; expiresAt: number | null; expired: boolean }[]; admin: boolean }> = {}) => ({
    who,
    roles: {},
    create: false,
    passwords: [],
    admin: false,
    ...partial,
  })

  test("a row's kind: password access when every project is through a password, a company account otherwise", () => {
    expect(personKind(person("bob@acme.test", { roles: { blog: "developer" } }))).toBe("account")
    expect(personKind(person("Client Bob", { roles: { shop: "visitor" }, passwords: [{ slug: "shop", expiresAt: null, expired: false }] }))).toBe("password")
    // A role with an account beside a password on another project: an account, who also has a password somewhere.
    expect(personKind(person("ann@acme.test", { roles: { blog: "viewer", shop: "visitor" }, passwords: [{ slug: "shop", expiresAt: null, expired: false }] }))).toBe("account")
    expect(personKind(person("maya@acme.test", { create: true }))).toBe("account")
  })

  test("people by name, ignoring case, then the domains, each keyed for its sheet", () => {
    const entries = peopleEntries(
      [person("bob@acme.test", { roles: { blog: "developer" } }), person("Ann", { roles: { shop: "visitor" }, passwords: [{ slug: "shop", expiresAt: null, expired: false }] })],
      [
        { slug: "shop", domain: "@acme.test" },
        { slug: "blog", domain: "@acme.test" },
      ],
    )
    expect(entries.map((entry) => [entry.key, entry.kind])).toEqual([
      ["Ann", "password"],
      ["bob@acme.test", "account"],
      ["@acme.test", "domain"],
    ])
    // Rows and count agree: one row per person and per domain, a domain on two projects once.
    expect(entries).toHaveLength(3)
    expect(entryProjects(entries[2]!, NOW)).toEqual([
      { slug: "blog", role: "Can open", password: false },
      { slug: "shop", role: "Can open", password: false },
    ])
    expect(entryProjects(entries[0]!, NOW)).toEqual([{ slug: "shop", role: "Password access", password: true }])
  })

  test("the search finds a row by who or by a project, accents and case aside", () => {
    const [one] = peopleEntries([person("Élodie Martin", { roles: { calendar: "visitor" }, passwords: [{ slug: "calendar", expiresAt: null, expired: false }] })], [])
    expect(entryMatches(one!, "elodie")).toBe(true)
    expect(entryMatches(one!, "CALENDAR")).toBe(true)
    expect(entryMatches(one!, "shop")).toBe(false)
  })

  test("Expires, for password access alone: the soonest end still open, in attention under a day", () => {
    expect(accessExpiry(person("bob@acme.test"), NOW)).toBeNull()
    expect(accessExpiry(person("A", { passwords: [{ slug: "shop", expiresAt: NOW + 5 * HOUR, expired: false }] }), NOW)).toEqual({ text: "in 5h", tone: "attention" })
    expect(accessExpiry(person("A", { passwords: [{ slug: "shop", expiresAt: NOW + 6 * 24 * HOUR, expired: false }, { slug: "blog", expiresAt: null, expired: false }] }), NOW)).toEqual({ text: "in 6d", tone: "plain" })
    expect(accessExpiry(person("A", { passwords: [{ slug: "shop", expiresAt: null, expired: false }] }), NOW)).toEqual({ text: "No expiry", tone: "muted" })
    expect(accessExpiry(person("A", { passwords: [{ slug: "shop", expiresAt: NOW - HOUR, expired: true }] }), NOW)).toEqual({ text: "Expired", tone: "muted" })
  })
})
