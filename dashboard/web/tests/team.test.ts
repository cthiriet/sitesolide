import { describe, expect, test } from "bun:test"
import {
  mintableProjects,
  optionsAllowed,
  validateMemberTokenForm,
  auditLine,
  deploymentLabel,
  deploymentTone,
  expiryFrom,
  firstTokenField,
  invitationText,
  isLive,
  loginCommand,
  parseSlugs,
  reachedProjects,
  scopeSummary,
  tokenRefusal,
  tokenStatus,
  validateTokenForm,
} from "../src/lib/team"

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const SCOPE = { slugs: [], create: false, outbound: false, domain: false, public: false }

describe("a token's state", () => {
  test("active, expiring soon, expired, revoked", () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: null }, NOW)).toEqual({ label: "Active", tone: "ok" })
    expect(tokenStatus({ revokedAt: null, expiresAt: NOW + 30 * DAY }, NOW)).toEqual({ label: "Active", tone: "ok" })
    expect(tokenStatus({ revokedAt: null, expiresAt: NOW + 3 * DAY }, NOW)).toEqual({ label: "Expires in 3d", tone: "attention" })
    expect(tokenStatus({ revokedAt: null, expiresAt: NOW }, NOW)).toEqual({ label: "Expired", tone: "neutral" })
    expect(tokenStatus({ revokedAt: NOW - 1, expiresAt: null }, NOW)).toEqual({ label: "Revoked", tone: "neutral" })
    expect(isLive({ revokedAt: null, expiresAt: NOW + 1 }, NOW)).toBe(true)
    expect(isLive({ revokedAt: null, expiresAt: NOW }, NOW)).toBe(false)
  })

  test("the scope in words, the door first", () => {
    expect(scopeSummary(SCOPE)).toEqual(["Private sites only"])
    expect(scopeSummary({ ...SCOPE, public: true, create: true, outbound: true, domain: true })).toEqual([
      "Public sites allowed",
      "Creates projects",
      "Outbound network",
      "Own domains",
    ])
  })

  test("the projects it reaches, created first, each once", () => {
    expect(reachedProjects({ owned: ["shop"], scope: { ...SCOPE, slugs: ["cms", "shop"] } })).toEqual([
      { slug: "shop", how: "created" },
      { slug: "cms", how: "granted" },
    ])
  })
})

describe("the form", () => {
  test("slugs separated by commas, spaces or lines, each once", () => {
    expect(parseSlugs(" cms, shop\nCMS  blog,")).toEqual(["cms", "shop", "blog"])
    expect(parseSlugs("")).toEqual([])
  })

  test("what it can see before sending", () => {
    const known = ["cms", "shop"]
    expect(validateTokenForm({ label: "Ada", email: "ada@test-zone.invalid", slugs: ["cms"] }, known)).toEqual({})
    expect(validateTokenForm({ label: " ", email: "ada", slugs: [] }, known)).toMatchObject({ label: expect.any(String), email: expect.any(String) })
    expect(validateTokenForm({ label: "Ada", email: "ada@test-zone.invalid", slugs: ["Bad Slug"] }, known).slugs).toContain("not a slug")
    expect(validateTokenForm({ label: "Ada", email: "ada@test-zone.invalid", slugs: ["blog"] }, known).slugs).toContain("Not on this machine: blog")
    expect(firstTokenField({ slugs: "x", email: "y" })).toBe("email")
    expect(firstTokenField({})).toBeNull()
  })

  test("an expiry in days from now, or none", () => {
    expect(expiryFrom(30, NOW)).toBe(NOW + 30 * DAY)
    expect(expiryFrom(null, NOW)).toBeNull()
  })

  test("the steward's refusal lands under the field it names", () => {
    expect(tokenRefusal(400, { error: "invalid", message: "scope.slugs: dashboard is reserved for the platform: pick another slug" })).toEqual({
      field: "slugs",
      message: "dashboard is reserved for the platform: pick another slug",
    })
    expect(tokenRefusal(400, { error: "invalid", message: "email: the address" }).field).toBe("email")
    expect(tokenRefusal(503, { error: "not-available", message: "run sitesolide upgrade" })).toEqual({ field: null, message: "run sitesolide upgrade" })
    expect(tokenRefusal(0, null).message).toBe("Can't reach the dashboard.")
  })
})

describe("what the holder receives", () => {
  test("the login command never carries the token, the invitation does, on its own line", () => {
    const origin = "https://dashboard.test-zone.invalid"
    const secret = `sst_${"x".repeat(43)}`
    expect(loginCommand(origin)).toBe("sitesolide login --url https://dashboard.test-zone.invalid")
    expect(loginCommand(origin)).not.toContain("sst_")
    expect(invitationText(origin, secret).split("\n")).toEqual([
      `Dashboard: ${origin}`,
      `Sign in: sitesolide login --url ${origin}`,
      `Token (paste it at the prompt): ${secret}`,
    ])
  })
})

describe("deployments and the audit", () => {
  test("a deployment's tone and word", () => {
    expect(deploymentTone("succeeded")).toBe("ok")
    expect(deploymentTone("failed")).toBe("error")
    expect(deploymentTone("running")).toBe("attention")
    expect(deploymentTone("expired")).toBe("neutral")
    expect(deploymentLabel("awaiting-bundle")).toBe("Uploading")
  })

  test("an audit line says who did what, with no value", () => {
    expect(auditLine({ actor: "owner", action: "token.create", target: null, detail: { email: "ada@test-zone.invalid", label: "Ada" } })).toBe(
      "You created a token for ada@test-zone.invalid (Ada)",
    )
    expect(auditLine({ actor: "token:aaaaaaaaaaaa", action: "deploy.success", target: "shop", detail: { email: "ada@test-zone.invalid" } })).toBe(
      "ada@test-zone.invalid deployed shop",
    )
    expect(auditLine({ actor: "token:aaaaaaaaaaaa", action: "deploy.failure", target: "shop", detail: { error: "install-failed" } })).toBe(
      "token:aaaaaaaaaaaa failed to deploy shop (install-failed)",
    )
    expect(auditLine({ actor: "system", action: "something.else", target: "x", detail: null })).toBe("system: something.else x")
  })
})

describe("a member's own token", () => {
  const roles = { alpha: "developer", beta: "admin", gamma: "viewer" } as const

  test("the projects offered: where they are a developer or a project admin, sorted", () => {
    expect(mintableProjects(roles)).toEqual([
      { slug: "alpha", role: "developer" },
      { slug: "beta", role: "admin" },
    ])
    expect(mintableProjects({ gamma: "viewer" })).toEqual([])
  })

  test("the options: a project admin of every project chosen, or a token that only creates", () => {
    expect(optionsAllowed(roles, ["beta"], false)).toBe(true)
    expect(optionsAllowed(roles, ["alpha", "beta"], false)).toBe(false)
    expect(optionsAllowed(roles, [], true)).toBe(true)
    expect(optionsAllowed(roles, [], false)).toBe(false)
  })

  test("a member's token opens no site to the public without the option, which says it better than private sites only", () => {
    expect(scopeSummary({ slugs: ["alpha"], create: false, outbound: false, domain: false, public: false }, true)[0]).toBe("Opens no site to the public")
    expect(scopeSummary({ slugs: ["alpha"], create: false, outbound: false, domain: false, public: false })[0]).toBe("Private sites only")
  })

  test("the form: a name, and something to deploy", () => {
    expect(validateMemberTokenForm({ label: "", slugs: ["alpha"], create: false })).toHaveProperty("label")
    expect(validateMemberTokenForm({ label: "laptop", slugs: [], create: false })).toHaveProperty("slugs")
    expect(validateMemberTokenForm({ label: "laptop", slugs: [], create: true })).toEqual({})
  })

  test("the steward's refusal above their roles, without the fields' prefixes, under the projects when it is about them", () => {
    const message = "scope.slugs: a@acme.test is a viewer on gamma: deploying it takes a developer or a project admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message })).toEqual({ field: "slugs", message: "a@acme.test is a viewer on gamma: deploying it takes a developer or a project admin" })
    const options = "scope.public: a@acme.test is a developer on alpha: deploying it in the open, without the portal, takes a project admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message: options }).field).toBeNull()
  })
})
