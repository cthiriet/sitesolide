import { describe, expect, test } from "bun:test"
import {
  mintableProjects,
  noProjectText,
  optionsAllowed,
  neededLine,
  holderLine,
  neededOptions,
  expiryCell,
  expiryFrom,
  firstTokenField,
  fitChips,
  foldLabel,
  lastUsed,
  messageText,
  isLive,
  loginCommand,
  ownerLabel,
  permissionChips,
  projectChips,
  reachedProjects,
  shortDate,
  splitTokens,
  tokenPermissions,
  liveReach,
  madeByLine,
  requestScope,
  STEWARD_PREDATES_SECRETS,
  tokenMatches,
  tokenRefusal,
  tokenStatus,
  tokenSummary,
  validateTokenForm,
  tokenHolders,
  tokenProjects,
} from "../src/lib/tokens"
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

  test("its permissions, only what is on, what opens a site to anyone first", () => {
    const keys = (scope: typeof SCOPE & { secrets?: boolean }) => tokenPermissions({ owned: [], member: null, scope }, null).map((one) => one.key)
    expect(keys(SCOPE)).toEqual([])
    expect(keys({ ...SCOPE, public: true, create: true, outbound: true, domain: true, secrets: true })).toEqual(["public", "secrets", "domain", "outbound", "create"])
    // A token minted before the permission carries no `secrets`: it manages none.
    expect(keys({ ...SCOPE, secrets: false })).toEqual([])
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
    expect(liveReach(token, { calendar: "admin", cms: "viewer", notes: "admin" })).toEqual([
      { slug: "notes", detail: "Admin", paused: false },
      { slug: "calendar", detail: "Admin", paused: false },
      { slug: "cms", detail: "Viewer now", paused: true },
      { slug: "photos", detail: "no role now", paused: true },
    ])
    expect(liveReach(token, { cms: "visitor" }).find((one) => one.slug === "cms")).toEqual({ slug: "cms", detail: "Can open now", paused: true })
    // The owner's own token: which projects it created.
    expect(liveReach({ ...token, member: null }, null).map((one) => one.detail)).toEqual(["created", null, null, null])
  })
})

describe("a person's token, what it may still do", () => {
  const token = { owned: [] as string[], member: "alice@example.com", scope: { slugs: ["cms", "calendar"], create: true, outbound: true, domain: false, public: false } }

  test("each option on, paused and said why while the person no longer holds it", () => {
    expect(tokenPermissions(token, { roles: { cms: "admin", calendar: "admin" }, create: true })).toEqual([
      { key: "outbound", pause: null },
      { key: "create", pause: null },
    ])
    expect(tokenPermissions(token, { roles: { cms: "developer", calendar: "admin" }, create: false })).toEqual([
      { key: "outbound", pause: "not Admin of cms now" },
      { key: "create", pause: "no longer allowed" },
    ])
    // A project where it no longer deploys does not hold an option back: it is paused there already.
    expect(tokenPermissions(token, { roles: { cms: "viewer", calendar: "admin" }, create: true })[0]).toEqual({ key: "outbound", pause: null })
    expect(tokenPermissions({ ...token, scope: { ...token.scope, create: false } }, { roles: {}, create: false })).toEqual([{ key: "outbound", pause: "no project to deploy now" }])
  })

  test("the owner's own, or rights not known: as it was made", () => {
    expect(tokenPermissions({ ...token, member: null }, null)).toEqual([
      { key: "outbound", pause: null },
      { key: "create", pause: null },
    ])
    expect(tokenPermissions({ ...token, member: null, scope: { ...token.scope, secrets: true } }, null)).toContainEqual({ key: "secrets", pause: null })
  })

  test("managing secrets, paused only while it deploys no project and may create none", () => {
    const secrets = { ...token, scope: { ...token.scope, secrets: true } }
    // A Developer manages a project's secrets already: not Admin of cms holds back the options, never this one.
    expect(tokenPermissions(secrets, { roles: { cms: "developer", calendar: "admin" }, create: true })).toContainEqual({ key: "secrets", pause: null })
    // A Viewer on both now, it still may create projects: the steward keeps it on.
    expect(tokenPermissions(secrets, { roles: { cms: "viewer", calendar: "viewer" }, create: true })).toContainEqual({ key: "secrets", pause: null })
    expect(tokenPermissions(secrets, { roles: { cms: "viewer" }, create: false })).toContainEqual({ key: "secrets", pause: "no project to deploy now" })
  })
})

describe("the table, one line per token", () => {
  const token = (partial: Partial<{ revokedAt: number | null; expiresAt: number | null; lastUsedAt: number | null }>) => ({ revokedAt: null, expiresAt: null, lastUsedAt: null, ...partial })

  test("revoked and expired fold under the list, the rest stays in its order", () => {
    const tokens = [
      { id: "a", ...token({ expiresAt: NOW + DAY }) },
      { id: "b", ...token({ revokedAt: NOW - DAY }) },
      { id: "c", ...token({}) },
      { id: "d", ...token({ expiresAt: NOW - 1 }) },
    ]
    const { live, ended } = splitTokens(tokens, NOW)
    expect(live.map((one) => one.id)).toEqual(["a", "c"])
    expect(ended.map((one) => one.id)).toEqual(["b", "d"])
    expect(foldLabel(1, false)).toBe("Show 1 revoked or expired")
    expect(foldLabel(2, true)).toBe("Hide 2 revoked or expired")
  })

  test("Expires: a date while far, within a week in attention, otherwise a muted word", () => {
    const zone = "UTC"
    const jan21 = Date.UTC(2027, 0, 21, 9, 0)
    expect(expiryCell(token({ expiresAt: jan21 }), Date.UTC(2027, 0, 1), zone)).toMatchObject({ text: "Jan 21", tone: "plain" })
    expect(expiryCell(token({ expiresAt: jan21 }), Date.UTC(2026, 11, 1), zone)).toMatchObject({ text: "Jan 21, 2027", tone: "plain" })
    expect(expiryCell(token({ expiresAt: NOW + 4 * DAY }), NOW)).toMatchObject({ text: "in 4d", tone: "attention" })
    expect(expiryCell(token({}), NOW)).toEqual({ text: "No expiry", tone: "muted", title: null })
    expect(expiryCell(token({ expiresAt: NOW - DAY }), NOW)).toMatchObject({ text: "Expired", tone: "muted" })
    expect(expiryCell(token({ revokedAt: NOW - DAY, expiresAt: NOW + 30 * DAY }), NOW)).toMatchObject({ text: "Revoked", tone: "muted" })
    expect(shortDate(jan21, jan21, zone)).toBe("Jan 21")
  })

  test("Last used, and whose a token is", () => {
    expect(lastUsed(token({ lastUsedAt: NOW - 5 * 3_600_000 }), NOW)).toBe("5h ago")
    expect(lastUsed(token({}), NOW)).toBe("Never")
    expect(ownerLabel({ member: null, email: "owner" })).toBe("You")
    expect(ownerLabel({ member: "alice@acme.test", email: "alice@acme.test" })).toBe("alice@acme.test")
    // From before every token belonged to someone: the address it was made for.
    expect(ownerLabel({ member: null, email: "bob@elsewhere.test" })).toBe("bob@elsewhere.test")
  })

  test("at most two chips, the second only when it fits beside a +N, the first always", () => {
    const width = (text: string) => text.length
    expect(fitChips(["Public sites", "Secrets", "Network"], width, { budget: 24 })).toEqual({ shown: ["Public sites", "Secrets"], more: 1 })
    expect(fitChips(["New projects", "Public sites"], width, { budget: 24 })).toEqual({ shown: ["New projects"], more: 1 })
    expect(fitChips(["Public sites", "Network"], width, { budget: 24 })).toEqual({ shown: ["Public sites", "Network"], more: 0 })
    expect(fitChips(["a-very-long-project-name-indeed"], width, { budget: 24 })).toEqual({ shown: ["a-very-long-project-name-indeed"], more: 0 })
    expect(fitChips([], width, { budget: 24 })).toEqual({ shown: [], more: 0 })
  })

  test("the live first, the paused after, in the Permissions and the Projects cells", () => {
    const chips = permissionChips([
      { key: "create", pause: "no longer allowed" },
      { key: "outbound", pause: null },
    ])
    expect(chips.shown.map((one) => one.key)).toEqual(["outbound", "create"])
    const projects = projectChips([
      { slug: "photos", detail: "Viewer now", paused: true },
      { slug: "cms", detail: "Developer", paused: false },
      { slug: "calendar", detail: "Admin", paused: false },
    ])
    expect(projects).toEqual({ shown: [{ slug: "cms", detail: "Developer", paused: false }, { slug: "calendar", detail: "Admin", paused: false }], more: 1 })
  })

  test("the search finds a token by its name, its owner or a project, accents and case aside", () => {
    const one = { label: "Release agent", member: "élise@acme.test", email: "élise@acme.test", owned: ["notes"], scope: { ...SCOPE, slugs: ["calendar"] } }
    expect(tokenMatches(one, "release")).toBe(true)
    expect(tokenMatches(one, "ELISE")).toBe(true)
    expect(tokenMatches(one, "notes calendar")).toBe(true)
    expect(tokenMatches(one, "cms")).toBe(false)
  })
})

describe("the dialog's summary", () => {
  test("what the token will be, in one line", () => {
    expect(tokenSummary({ slugs: ["cms", "photos"], create: false, permissions: [], expiryDays: 90 })).toBe("Deploys cms and photos, expires in 90 days, no extra permission.")
    expect(tokenSummary({ slugs: ["a", "b", "c"], create: true, permissions: ["secrets", "public"], expiryDays: 365 })).toBe(
      "Deploys 3 projects and new projects, expires in 1 year, with public sites and secrets.",
    )
    expect(tokenSummary({ slugs: [], create: true, permissions: ["outbound"], expiryDays: null })).toBe("Deploys the new projects it creates, never expires, with outbound network.")
    expect(tokenSummary({ slugs: [], create: false, permissions: [], expiryDays: 30 })).toBe("Deploys nothing yet, expires in 30 days, no extra permission.")
    expect(tokenSummary({ slugs: ["cms"], create: false, permissions: ["domain", "outbound", "public"], expiryDays: 30 })).toBe(
      "Deploys cms, expires in 30 days, with public sites, a domain and outbound network.",
    )
  })
})
