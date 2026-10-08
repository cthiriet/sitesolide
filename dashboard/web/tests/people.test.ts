import { describe, expect, test } from "bun:test"
import { createFieldError, createRefusal, domainGroups, mayGetCreate, mayRemove, projectRoles } from "../src/lib/people"
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
})
