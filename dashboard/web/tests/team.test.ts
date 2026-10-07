import { describe, expect, test } from "bun:test"
import {
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
