import { describe, expect, test } from "bun:test"
import {
  mintableProjects,
  noProjectText,
  optionsAllowed,
  neededLine,
  holderLine,
  neededOptions,
  auditLine,
  deploymentLabel,
  deploymentTone,
  expiryFrom,
  firstTokenField,
  messageText,
  isLive,
  loginCommand,
  reachedProjects,
  scopeSummary,
  scopeLines,
  liveReach,
  madeByLine,
  requestScope,
  STEWARD_PREDATES_SECRETS,
  tokenActivity,
  tokenActor,
  tokenRefusal,
  tokenStatus,
  validateTokenForm,
  tokenHolders,
  tokenProjects,
} from "../src/lib/tokens"
import type { AuditEntry, AuditRow } from "../src/lib/types"
import { site } from "./factory"

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
    expect(scopeSummary({ ...SCOPE, public: true, create: true, outbound: true, domain: true, secrets: true })).toEqual([
      "Can create projects",
      "Can deploy public sites",
      "Can declare a domain",
      "Can use outbound network",
      "Can manage secrets",
    ])
    // A token minted before the permission carries no `secrets`: it manages none.
    expect(scopeSummary({ ...SCOPE, secrets: false })).toEqual([])
  })

  test("the projects it reaches, created first, each once", () => {
    expect(reachedProjects({ owned: ["shop"], scope: { ...SCOPE, slugs: ["cms", "shop"] } })).toEqual([
      { slug: "shop", how: "created" },
      { slug: "cms", how: "granted" },
    ])
  })
})

describe("the form", () => {
  test("what it can see before sending: a name, and something to deploy", () => {
    expect(validateTokenForm({ label: "Ada", slugs: ["cms"], create: false })).toEqual({})
    expect(validateTokenForm({ label: " ", slugs: ["cms"], create: false })).toMatchObject({ label: expect.any(String) })
    expect(validateTokenForm({ label: "Ada", slugs: [], create: false })).toHaveProperty("slugs")
    expect(validateTokenForm({ label: "Ada", slugs: [], create: true })).toEqual({})
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

  test("Manage secrets ticked against a steward that predates it: what to run, not the steward's words", () => {
    expect(tokenRefusal(400, { error: "invalid", message: "unexpected field in the scope" })).toEqual({ field: null, message: STEWARD_PREDATES_SECRETS })
    expect(STEWARD_PREDATES_SECRETS).toBe("The server's steward predates this permission: run sitesolide upgrade.")
  })

  test("the permission is sent only when ticked: an older steward still mints a token without it", () => {
    const choices = { create: false, outbound: true, domain: false, public: false }
    expect(requestScope({ ...choices, secrets: false }, ["cms"])).toEqual({ ...choices, slugs: ["cms"] })
    expect(Object.hasOwn(requestScope({ ...choices, secrets: false }, ["cms"]), "secrets")).toBe(false)
    expect(requestScope(choices, [])).toEqual({ ...choices, slugs: [] })
    expect(requestScope({ ...choices, secrets: true }, ["cms", "shop"])).toEqual({ ...choices, secrets: true, slugs: ["cms", "shop"] })
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

describe("the projects offered", () => {
  const sites = [
    site({ slug: "shop", portal: { wanted: false, installed: false, exemptions: [] }, domain: { name: "shop.example", aliases: [], active: true, route: true } }),
    site({ slug: "cms", portal: { wanted: true, installed: true, exemptions: [] } }),
    site({ slug: "calendar", portal: { wanted: true, installed: true, exemptions: ["/book"] } }),
    site({ slug: "dashboard" }),
    site({ slug: "test-zone.invalid" }),
  ]

  test("every project but the platform's own, sorted, with what deploying it takes", () => {
    expect(tokenProjects(sites, "test-zone.invalid")).toEqual([
      { slug: "calendar", open: false, exempt: true, domain: false },
      { slug: "cms", open: false, exempt: false, domain: false },
      { slug: "shop", open: true, exempt: false, domain: true },
    ])
  })

  test("an option a project chosen cannot be deployed without, with the projects that need it", () => {
    const projects = tokenProjects(sites, "test-zone.invalid")
    expect(neededOptions(projects, ["cms"], false)).toEqual({ public: [], domain: [] })
    expect(neededOptions(projects, ["shop", "calendar"], false)).toEqual({ public: ["calendar", "shop"], domain: ["shop"] })
    // A person's token deploys a public project as it stands: exempted paths and a domain still take the option.
    expect(neededOptions(projects, ["shop", "calendar"], true)).toEqual({ public: ["calendar"], domain: ["shop"] })
  })

  test("which projects need it, in a few words", () => {
    expect(neededLine(["cms"])).toBe("Needed by cms")
    expect(neededLine(["cms", "shop"])).toBe("Needed by cms and shop")
    expect(neededLine(["blog", "cms", "shop"])).toBe("Needed by blog, cms and shop")
    expect(neededLine(["blog", "cms", "shop", "wiki"])).toBe("Needed by blog, cms and 2 more")
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

  test("nothing to offer: no project yet, or a Viewer on each", () => {
    expect(noProjectText({}, null)).toBe("No project yet.")
    expect(noProjectText({}, "maya@example.com")).toBe("maya@example.com has no project yet.")
    expect(noProjectText({ gamma: "viewer" }, null)).toBe("None of your projects: you are a Viewer on each.")
    expect(noProjectText({ gamma: "viewer" }, "maya@example.com")).toBe("None of maya@example.com's projects: a Viewer on each.")
  })

  test("a person the owner may make a token for, in one line: where they deploy, then the create right", () => {
    expect(holderLine({ roles, create: false })).toBe("Developer on alpha, Admin on beta")
    expect(holderLine({ roles: {}, create: true })).toBe("May create projects")
    expect(holderLine({ roles: { a: "admin", b: "developer", c: "developer" }, create: true })).toBe("Developer or Admin on 3 projects · May create projects")
    expect(holderLine({ roles: { gamma: "viewer" }, create: false })).toBe("Viewer only")
  })

  test("the options: an Admin of every project chosen, or a token that only creates", () => {
    expect(optionsAllowed(roles, ["beta"], false)).toBe(true)
    expect(optionsAllowed(roles, ["alpha", "beta"], false)).toBe(false)
    expect(optionsAllowed(roles, [], true)).toBe(true)
    expect(optionsAllowed(roles, [], false)).toBe(false)
  })

  test("the steward's refusal above their roles, without the fields' prefixes, under the projects when it is about them", () => {
    const message = "scope.slugs: a@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message })).toEqual({ field: "slugs", message: "a@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin" })
    const options = "scope.public: a@acme.test is a Developer on alpha: deploying it in the open, its general access public, takes an Admin"
    expect(tokenRefusal(403, { error: "out-of-scope", message: options }).field).toBeNull()
  })
})

describe("whose a token is", () => {
  test("the owner makes one for the people who deploy or create, never for a Viewer nor someone who can only open sites", () => {
    expect(
      tokenHolders([
        { who: "zed@acme.test", roles: { blog: "developer", shop: "visitor" }, create: false },
        { who: "ann@acme.test", roles: {}, create: true },
        { who: "guest@example.org", roles: { blog: "visitor" }, create: false },
        { who: "Client Bob", roles: { blog: "visitor" }, create: false },
        { who: "vera@acme.test", roles: { blog: "viewer" }, create: false },
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
    expect(scopeLines({ ...token, member: null, scope: { ...token.scope, secrets: true } }, null)).toContainEqual({ text: "Can manage secrets", paused: false })
  })

  test("managing secrets, paused only while it deploys no project and may create none", () => {
    const secrets = { ...token, scope: { ...token.scope, secrets: true } }
    // A Developer manages a project's secrets already: not Admin of cms holds back the options, never this one.
    expect(scopeLines(secrets, { roles: { cms: "developer", calendar: "admin" }, create: true })).toContainEqual({ text: "Can manage secrets", paused: false })
    // A Viewer on both now, it still may create projects: the steward keeps it on.
    expect(scopeLines(secrets, { roles: { cms: "viewer", calendar: "viewer" }, create: true })).toContainEqual({ text: "Can manage secrets", paused: false })
    expect(scopeLines(secrets, { roles: { cms: "viewer" }, create: false })).toContainEqual({ text: "Can manage secrets (paused: no project to deploy now)", paused: true })
  })
})

describe("Token activity", () => {
  const AT = "2026-10-04T12:00:00.000Z"
  const ms = Date.parse(AT)
  const tokens = [
    { id: "aaaaaaaaaaaa", label: "Release agent", member: null },
    { id: "bbbbbbbbbbbb", label: "alice-ci", member: "alice@example.com" },
  ]
  const entry = (id: number, at: number, partial: Partial<AuditEntry>): AuditEntry => ({ id, at: new Date(at).toISOString(), actor: "owner", action: "token.create", target: null, detail: null, ...partial })
  const work = (at: number, partial: Partial<AuditRow>): AuditRow => ({
    id: `steward:${at}.0`,
    source: "steward",
    at: new Date(at).toISOString(),
    actor: "token:aaaaaaaaaaaa",
    action: "secrets.set",
    target: "cms",
    site: null,
    detail: { result: "ok", file: "cms.env", variable: "API_KEY" },
    ...partial,
  })

  test("a token is named by its label; a person's with their email for the owner; one not listed as Activity names it", () => {
    expect(tokenActor(work(ms, {}), tokens, "owner")).toBe("Release agent")
    const hers = work(ms, { actor: "token:bbbbbbbbbbbb", detail: { result: "ok", variable: "API_KEY", member: "alice@example.com" } })
    expect(tokenActor(hers, tokens, "owner")).toBe("alice-ci (alice@example.com)")
    expect(tokenActor(hers, tokens, "person")).toBe("alice-ci")
    expect(tokenActor({ ...hers, actor: "token:cccccccccccc" }, tokens, "owner")).toBe("alice@example.com (token)")
    expect(tokenActor(work(ms, { actor: "token:cccccccccccc" }), tokens, "owner")).toBe("A token")
  })

  test("the dashboard's lines and the steward's, merged newest first, the steward's in Activity's words", () => {
    const lines = tokenActivity(
      [
        entry(2, ms - 1000, { actor: "token:aaaaaaaaaaaa", action: "deploy.success", target: "cms", detail: { email: "owner" } }),
        entry(1, ms - 5000, { detail: { email: "alice@example.com", label: "alice-ci" } }),
      ],
      [
        work(ms, { action: "service.restart", detail: { result: "ok", note: "active, active/running, 0 restarts" } }),
        work(ms - 2000, {}),
        work(ms - 3000, { actor: "token:bbbbbbbbbbbb", target: "shop", detail: { result: "rejects", file: "shop.env", note: "no secrets permission", member: "alice@example.com" } }),
      ],
      tokens,
      "owner",
    )
    expect(lines.map(({ text, tone, meta }) => ({ text, tone, meta }))).toEqual([
      { text: "Restarted", tone: "neutral", meta: "Release agent · cms · Active, active/running, 0 restarts" },
      { text: "owner deployed cms", tone: "neutral", meta: null },
      { text: "Set API_KEY", tone: "neutral", meta: "Release agent · cms" },
      { text: "Tried to set", tone: "attention", meta: "alice-ci (alice@example.com) · shop · Refused: no secrets permission" },
      { text: "You created a token for alice@example.com (alice-ci)", tone: "neutral", meta: null },
    ])
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length)
  })

  test("the latest lines alone, and nothing when neither source has any", () => {
    const many = Array.from({ length: 40 }, (_, index) => work(ms - index, { id: `steward:${ms - index}.0` }))
    const older = Array.from({ length: 40 }, (_, index) => entry(index + 1, ms - 100 - index, {}))
    const lines = tokenActivity(older, many, tokens, "owner")
    expect(lines).toHaveLength(50)
    expect(lines.slice(0, 40).every((line) => line.text === "Set API_KEY")).toBe(true)
    expect(tokenActivity([], [], tokens, "person")).toEqual([])
  })
})
