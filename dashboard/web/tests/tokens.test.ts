import { describe, expect, test } from "bun:test"
import {
  neededLine,
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
  madeFor,
  permissionChips,
  projectChips,
  reachedProjects,
  shortDate,
  splitTokens,
  tokenPermissions,
  liveReach,
  reachesEveryProject,
  requestScope,
  STEWARD_PREDATES_SECRETS,
  tokenMatches,
  tokenRefusal,
  tokenStatus,
  tokenSummary,
  validateTokenForm,
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
    const keys = (scope: typeof SCOPE & { secrets?: boolean; all?: boolean }) => tokenPermissions({ scope })
    expect(keys(SCOPE)).toEqual([])
    expect(keys({ ...SCOPE, public: true, create: true, outbound: true, domain: true, secrets: true })).toEqual(["public", "secrets", "domain", "outbound", "create"])
    // A token minted before the permission carries no `secrets`: it manages none.
    expect(keys({ ...SCOPE, secrets: false })).toEqual([])
    expect(keys({ ...SCOPE, all: true, create: true })).toEqual(["all", "create"])
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
    expect(tokenRefusal(400, { error: "invalid", message: "expiresAt: a date in the future" }).field).toBeNull()
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
    expect(neededOptions(projects, ["cms"])).toEqual({ public: [], domain: [] })
    expect(neededOptions(projects, ["shop", "calendar"])).toEqual({ public: ["calendar", "shop"], domain: ["shop"] })
  })

  test("which projects need it, in a few words", () => {
    expect(neededLine(["cms"])).toBe("Needed by cms")
    expect(neededLine(["cms", "shop"])).toBe("Needed by cms and shop")
    expect(neededLine(["blog", "cms", "shop"])).toBe("Needed by blog, cms and shop")
    expect(neededLine(["blog", "cms", "shop", "wiki"])).toBe("Needed by blog, cms and 2 more")
  })
})

describe("whom a token was made for", () => {
  test("the owner's own says nothing; one from before every token was the owner's names its address", () => {
    expect(madeFor({ email: "owner" })).toBeNull()
    expect(madeFor({ email: "bob@elsewhere.test" })).toBe("bob@elsewhere.test")
  })

  test("where it deploys: what it created first, then what it was given", () => {
    const token = { owned: ["notes"], scope: { ...SCOPE, slugs: ["calendar", "notes", "cms"] } }
    expect(liveReach(token)).toEqual([
      { slug: "notes", detail: "created" },
      { slug: "calendar", detail: null },
      { slug: "cms", detail: null },
    ])
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

  test("Last used", () => {
    expect(lastUsed(token({ lastUsedAt: NOW - 5 * 3_600_000 }), NOW)).toBe("5h ago")
    expect(lastUsed(token({}), NOW)).toBe("Never")
  })

  test("at most two chips, the second only when it fits beside a +N, the first always", () => {
    const width = (text: string) => text.length
    expect(fitChips(["Public sites", "Secrets", "Network"], width, { budget: 24 })).toEqual({ shown: ["Public sites", "Secrets"], more: 1 })
    expect(fitChips(["New projects", "Public sites"], width, { budget: 24 })).toEqual({ shown: ["New projects"], more: 1 })
    expect(fitChips(["Public sites", "Network"], width, { budget: 24 })).toEqual({ shown: ["Public sites", "Network"], more: 0 })
    expect(fitChips(["a-very-long-project-name-indeed"], width, { budget: 24 })).toEqual({ shown: ["a-very-long-project-name-indeed"], more: 0 })
    expect(fitChips([], width, { budget: 24 })).toEqual({ shown: [], more: 0 })
  })

  test("the Permissions and the Projects cells, in their order", () => {
    expect(permissionChips(["outbound", "create"])).toEqual({ shown: ["outbound", "create"], more: 0 })
    expect(permissionChips(["public", "secrets", "domain"])).toEqual({ shown: ["public", "secrets"], more: 1 })
    const projects = projectChips([
      { slug: "cms", detail: "created" },
      { slug: "calendar", detail: null },
      { slug: "photos", detail: null },
    ])
    expect(projects).toEqual({ shown: [{ slug: "cms", detail: "created" }, { slug: "calendar", detail: null }], more: 1 })
  })

  test("the search finds a token by its name, the address it was made for or a project, accents and case aside", () => {
    const one = { label: "Release agent", email: "élise@acme.test", owned: ["notes"], scope: { ...SCOPE, slugs: ["calendar"] } }
    expect(tokenMatches(one, "release")).toBe(true)
    expect(tokenMatches(one, "ELISE")).toBe(true)
    expect(tokenMatches(one, "notes calendar")).toBe(true)
    expect(tokenMatches(one, "cms")).toBe(false)
    // The owner's own: "owner" is no word of its own to find it by.
    expect(tokenMatches({ ...one, email: "owner" }, "owner")).toBe(false)
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

  test("every project: no project names, no list of the permissions it carries", () => {
    // As the dialog builds it: every permission held, the projects ticked before left in `slugs`.
    expect(tokenSummary({ slugs: ["cms"], create: true, permissions: ["all", "public", "secrets", "domain", "outbound"], expiryDays: 90 })).toBe(
      "Deploys every project as you, with every permission, expires in 90 days.",
    )
    expect(tokenSummary({ slugs: [], create: true, permissions: ["all"], expiryDays: null })).toBe("Deploys every project as you, with every permission, never expires.")
  })
})

describe("a token that deploys every project", () => {
  test("is told by its scope, its empty list of projects meaning nothing", () => {
    expect(reachesEveryProject({ scope: { ...SCOPE, all: true } })).toBe(true)
    expect(reachesEveryProject({ scope: SCOPE })).toBe(false)
  })
})
