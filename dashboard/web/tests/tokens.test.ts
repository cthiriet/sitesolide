import { describe, expect, test } from "bun:test"
import {
  mintableProjects,
  optionsAllowed,
  validatePersonTokenForm,
  auditLine,
  deploymentLabel,
  deploymentTone,
  expiryFrom,
  firstTokenField,
  messageText,
  isLive,
  loginCommand,
  parseSlugs,
  reachedProjects,
  scopeSummary,
  scopeLines,
  liveReach,
  madeByLine,
  tokenRefusal,
  tokenStatus,
  validateTokenForm,
  tokenHolders,
} from "../src/lib/tokens"

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

  test("the scope in words, only what is on", () => {
    expect(scopeSummary(SCOPE)).toEqual([])
    expect(scopeSummary({ ...SCOPE, public: true, create: true, outbound: true, domain: true })).toEqual([
      "Can create projects",
      "Can deploy public sites",
      "Can declare a domain",
      "Can use outbound network",
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
    expect(validateTokenForm({ label: "Ada", slugs: ["cms"] }, known)).toEqual({})
    expect(validateTokenForm({ label: " ", slugs: [] }, known)).toMatchObject({ label: expect.any(String) })
    expect(validateTokenForm({ label: "Ada", slugs: ["Bad Slug"] }, known).slugs).toContain("not a slug")
    expect(validateTokenForm({ label: "Ada", slugs: ["blog"] }, known).slugs).toContain("Not on this machine: blog")
    expect(firstTokenField({ slugs: "x", label: "y" })).toBe("label")
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
    expect(tokenRefusal(400, { error: "invalid", message: "holder: owner, for a token of your own, or the email of a person of People" }).field).toBeNull()
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
    expect(messageText(origin, secret).split("\n")).toEqual([
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

describe("a person's own token", () => {
  const roles = { alpha: "developer", beta: "admin", gamma: "viewer" } as const

  test("the projects offered: where they are a Developer or an Admin, sorted", () => {
    expect(mintableProjects(roles)).toEqual([
      { slug: "alpha", role: "developer" },
      { slug: "beta", role: "admin" },
    ])
    expect(mintableProjects({ gamma: "viewer" })).toEqual([])
  })

  test("the options: an Admin of every project chosen, or a token that only creates", () => {
    expect(optionsAllowed(roles, ["beta"], false)).toBe(true)
    expect(optionsAllowed(roles, ["alpha", "beta"], false)).toBe(false)
    expect(optionsAllowed(roles, [], true)).toBe(true)
    expect(optionsAllowed(roles, [], false)).toBe(false)
  })

  test("the form: a name, and something to deploy", () => {
    expect(validatePersonTokenForm({ label: "", slugs: ["alpha"], create: false })).toHaveProperty("label")
    expect(validatePersonTokenForm({ label: "laptop", slugs: [], create: false })).toHaveProperty("slugs")
    expect(validatePersonTokenForm({ label: "laptop", slugs: [], create: true })).toEqual({})
  })

  test("the steward's refusal above their roles, without the fields' prefixes, under the projects when it is about them", () => {
    const message = "scope.slugs: a@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message })).toEqual({ field: "slugs", message: "a@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin" })
    const options = "scope.public: a@acme.test is a Developer on alpha: deploying it in the open, its general access public, takes an Admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message: options }).field).toBeNull()
  })
})

describe("whose a token is", () => {
  test("the owner makes one for the people who sign in, never for someone who can only open sites", () => {
    expect(
      tokenHolders([
        { who: "zed@acme.test", roles: { blog: "developer", shop: "visitor" }, create: false },
        { who: "ann@acme.test", roles: {}, create: true },
        { who: "guest@example.org", roles: { blog: "visitor" }, create: false },
        { who: "Client Bob", roles: { blog: "visitor" }, create: false },
      ]),
    ).toEqual([
      { email: "ann@acme.test", roles: {}, create: true },
      { email: "zed@acme.test", roles: { blog: "developer" }, create: false },
    ])
  })

  test("each row says who made it, and for whom, to the owner and to the person", () => {
    expect(madeByLine({ member: null, by: "owner", email: "owner" }, "owner")).toBe("Made by you")
    expect(madeByLine({ member: null, by: "owner", email: "bob@elsewhere.test" }, "owner")).toBe("Made by you for bob@elsewhere.test")
    expect(madeByLine({ member: "alice@acme.test", by: "owner", email: "alice@acme.test" }, "owner")).toBe("Made by you for alice@acme.test")
    expect(madeByLine({ member: "alice@acme.test", by: "alice@acme.test", email: "alice@acme.test" }, "owner")).toBe("Made by alice@acme.test")
    expect(madeByLine({ member: "alice@acme.test", by: "owner", email: "alice@acme.test" }, "person")).toBe("Made by the owner for you")
    expect(madeByLine({ member: "alice@acme.test", by: "alice@acme.test", email: "alice@acme.test" }, "person")).toBe("Made by you")
  })

  test("a person's token deploys where their role is Developer or Admin today, and is paused elsewhere", () => {
    const token = { owned: ["notes"], scope: { ...SCOPE, slugs: ["calendar", "cms", "photos"] }, member: "alice@acme.test" }
    expect(liveReach(token, { calendar: "admin", cms: "viewer", notes: "admin" }).map((one) => one.text)).toEqual([
      "notes (Admin)",
      "calendar (Admin)",
      "cms (paused: Viewer now)",
      "photos (paused: no role now)",
    ])
    expect(liveReach(token, { cms: "visitor" }).find((one) => one.slug === "cms")).toEqual({ slug: "cms", text: "cms (paused: Can open now)", paused: true })
    // The owner's own token: which projects it created.
    expect(liveReach({ ...token, member: null }, null).map((one) => one.text)).toEqual(["notes (created)", "calendar", "cms", "photos"])
  })
})

describe("a person's token, what it may still do", () => {
  const token = { owned: [] as string[], member: "alice@example.com", scope: { slugs: ["cms", "calendar"], create: true, outbound: true, domain: false, public: false } }

  test("each option on, paused and said why while the person no longer holds it", () => {
    expect(scopeLines(token, { roles: { cms: "admin", calendar: "admin" }, create: true })).toEqual([
      { text: "Can create projects", paused: false },
      { text: "Can use outbound network", paused: false },
    ])
    expect(scopeLines(token, { roles: { cms: "developer", calendar: "admin" }, create: false })).toEqual([
      { text: "Can create projects (paused: no longer allowed)", paused: true },
      { text: "Can use outbound network (paused: not Admin of cms now)", paused: true },
    ])
    // A project where it no longer deploys does not hold an option back: it is paused there already.
    expect(scopeLines(token, { roles: { cms: "viewer", calendar: "admin" }, create: true })[1]).toEqual({ text: "Can use outbound network", paused: false })
    expect(scopeLines({ ...token, scope: { ...token.scope, create: false } }, { roles: {}, create: false })).toEqual([{ text: "Can use outbound network (paused: no project to deploy now)", paused: true }])
  })

  test("the owner's own, or rights not known: as it was made", () => {
    expect(scopeLines({ ...token, member: null }, null)).toEqual([
      { text: "Can create projects", paused: false },
      { text: "Can use outbound network", paused: false },
    ])
  })
})
