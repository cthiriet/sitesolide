import { describe, expect, test } from "bun:test"
import {
  CHANGE_SCALE_MS,
  CHANGE_SLOW_MS,
  DEFAULT_PASSWORD_DURATION_S,
  GENERAL_CHOICES,
  LADDER,
  OWNER_TEXT,
  PASSWORD_DURATIONS,
  ROLE_TEXTS,
  accountWords,
  byText,
  changeProgress,
  changeTexts,
  closeOutcome,
  codeCommands,
  confirmationValid,
  entryRow,
  gatekeeperSteps,
  generalOptions,
  generalState,
  inertNote,
  needsUnlock,
  passwordExpiry,
  passwordMessage,
  planAddition,
  raiseNeedsUnlock,
  readWho,
  readingProblem,
  refusalText,
  removalConfirmation,
  roleLabel,
  rolesSummary,
  sendLine,
  signsInWithAccount,
  sortEntries,
  type SignIn,
  type Viewer,
} from "../src/lib/access"
import type { AccessRole, EntryView } from "../src/lib/types"
import { site } from "./factory"

const NOW = 1_791_000_000_000
const HOUR = 3600_000
const DAY = 24 * HOUR

const SIGN_IN: SignIn = { configured: true, allowedDomains: ["acme.test"], admins: ["root@else.test"], providerName: "Google" }
const NO_SIGN_IN: SignIn = { configured: false, allowedDomains: [], admins: [], providerName: null }
const OWNER: Viewer = { kind: "owner" }
const ADMIN: Viewer = { kind: "person", email: "ann@acme.test", role: "admin" }
const ALL: AccessRole[] = ["visitor", "viewer", "developer", "admin"]

function entry(who: string, role: AccessRole = "visitor", fields: Partial<EntryView> = {}): EntryView {
  return { who, kind: who.startsWith("@") ? "domain" : "person", role, by: "owner", createdAt: NOW - DAY, updatedAt: NOW - DAY, password: null, ...fields }
}

function password(who: string, expiresAt: number | null): EntryView {
  return entry(who, "visitor", { kind: "password", password: { expiresAt, expired: expiresAt !== null && expiresAt <= NOW } })
}

const page = (fields: Partial<{ entries: EntryView[]; signIn: SignIn; grantable: AccessRole[]; you: Viewer }> = {}) => ({
  entries: [],
  signIn: SIGN_IN,
  grantable: ALL,
  you: OWNER,
  ...fields,
})

describe("the roles", () => {
  test("one ladder, from Can open to Admin, each in the spec's words, and the owner above it", () => {
    expect(LADDER).toEqual(ALL)
    expect(ALL.map(roleLabel)).toEqual(["Can open", "Viewer", "Developer", "Admin"])
    expect(OWNER_TEXT.label).toBe("Owner")
    // Each rung says what it adds to the one below.
    for (const role of ["viewer", "developer", "admin"] as const) expect(ROLE_TEXTS[role].can.startsWith("Also ")).toBe(true)
    expect(rolesSummary({ shop: "viewer", blog: "developer", cms: "admin" })).toBe("blog: Developer, cms: Admin, shop: Viewer")
  })

  test("raising above Can open, or drawing a password, waits for the unlock; lowering and Can open never do", () => {
    expect(needsUnlock("visitor", false)).toBe(false)
    expect(needsUnlock("visitor", true)).toBe(true)
    expect(needsUnlock("viewer", false)).toBe(true)
    expect(raiseNeedsUnlock("visitor", "developer")).toBe(true)
    expect(raiseNeedsUnlock("viewer", "admin")).toBe(true)
    expect(raiseNeedsUnlock("admin", "viewer")).toBe(false)
    expect(raiseNeedsUnlock("developer", "visitor")).toBe(false)
  })
})

describe("general access", () => {
  test("three ways a site opens, each with one plain sentence", () => {
    expect(GENERAL_CHOICES.map((choice) => choice.title)).toEqual(["Public", "Restricted", "Anyone with the code"])
    for (const choice of GENERAL_CHOICES) expect(choice.sentence).toMatch(/^[A-Z].*\.$/)
  })

  test("read from the snapshot: restricted with its public paths, the code with its link, public otherwise", () => {
    expect(generalState(site({ portal: { wanted: true, installed: true, exemptions: ["/api/*"] } }))).toEqual({ current: "restricted", problem: null, exemptions: ["/api/*"], code: null })
    expect(generalState(site({ lock: { closed: true, code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" } }))).toMatchObject({
      current: "code",
      code: { code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" },
    })
    expect(generalState(site())).toEqual({ current: "public", problem: null, exemptions: [], code: null })
  })

  test("a disagreement with sitesolide.json comes first, and says how the server serves the site", () => {
    const absent = generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } }))
    expect(absent.current).toBe("public")
    expect(absent.problem).toMatchObject({ portal: true })
    expect(absent.problem?.detail).toContain("anyone can open it")
    expect(generalState(site({ portal: { wanted: false, installed: true, exemptions: [] } }))).toMatchObject({ current: "restricted", problem: { portal: true } })
    expect(generalState(site({ lock: { closed: false, code: "AB12CD", url: null } }))).toMatchObject({ current: "code", problem: { portal: false } })
    expect(generalState(site({ lock: { closed: true, code: null, url: null } }))).toMatchObject({ current: "public", problem: { portal: false } })
  })

  const modifiable = { modifiable: true, reason: null }

  test("an Admin or the owner switches between public and restricted; a code is the CLI's, from the project's folder", () => {
    const options = generalOptions(generalState(site()), modifiable, true)
    expect(options.map((option) => [option.access, option.current, option.available])).toEqual([
      ["public", true, false],
      ["restricted", false, true],
      ["code", false, false],
    ])
    expect(options[2]).toMatchObject({ command: "sitesolide lock" })
  })

  test("while a code is set, public and restricted wait for it to be removed", () => {
    const options = generalOptions(generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } })), modifiable, true)
    expect(options.filter((option) => option.available)).toEqual([])
    expect(options[0]?.reason).toContain("Remove the preview code first")
    expect(codeCommands(true).map((command) => command.command)).toEqual(["sitesolide lock --new-code", "sitesolide unlock"])
    expect(codeCommands(false)).toEqual([{ label: "Give it a preview code", command: "sitesolide lock" }])
  })

  test("in disagreement, both public and restricted may be chosen: either brings the two sides together", () => {
    const options = generalOptions(generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } })), modifiable, true)
    expect(options.filter((option) => option.available).map((option) => option.access)).toEqual(["public", "restricted"])
  })

  test("nothing to choose for a Viewer or a Developer, nor before the steward answers; its reason when it refuses", () => {
    const state = generalState(site())
    expect(generalOptions(state, modifiable, false).some((option) => option.available || option.reason !== null)).toBe(false)
    expect(generalOptions(state, null, true).some((option) => option.available && option.access !== "code")).toBe(false)
    const refused = generalOptions(state, { modifiable: false, reason: "Caddy's lock is held" }, true)
    expect(refused[1]).toMatchObject({ available: false, reason: "Caddy's lock is held" })
  })

  test("the change says what it does; making a site public retypes its slug, without the blanks of an entry", () => {
    expect(changeTexts("cms", "restricted")).toMatchObject({ title: "Restrict cms?", action: "Restrict", succeeded: "cms is restricted" })
    expect(changeTexts("cms", "public")).toMatchObject({ title: "Make cms public?", action: "Make public", failure: "Couldn't make cms public" })
    expect(changeTexts("cms", "public").consequence).toContain("without signing in")
    expect(confirmationValid("  cms ", "cms")).toBe(true)
    expect(removalConfirmation("  cms ")).toBe("cms")
    expect(confirmationValid("CMS", "cms")).toBe(false)
    expect(gatekeeperSteps("cms").at(-1)).toContain("cms")
  })

  test("the wait shows the time elapsed, never beyond the track nor below it", () => {
    expect(CHANGE_SLOW_MS).toBeLessThan(CHANGE_SCALE_MS)
    expect(changeProgress(0)).toEqual({ part: 0, elapsed: "0s", slow: false })
    expect(changeProgress(CHANGE_SLOW_MS)).toMatchObject({ slow: true, elapsed: "30s" })
    expect(changeProgress(10 * CHANGE_SCALE_MS)).toMatchObject({ part: 1 })
    expect(changeProgress(-1000)).toMatchObject({ part: 0, elapsed: "0s" })
  })

  /** The track promises a result before its end: it covers the longest answer the relay waits for, read back from the protocol. */
  test("the track covers the longest gatekeeper answer the relay waits for", async () => {
    const protocol = await Bun.file(new URL("../../src/secrets/protocol.ts", import.meta.url)).text()
    const found = /export const MAX_PORTAL_MS = ([\d_]+)/.exec(protocol)
    expect(found).not.toBeNull()
    expect(CHANGE_SCALE_MS).toBeGreaterThanOrEqual(Number((found?.[1] ?? "").replaceAll("_", "")))
  })

  test("the code's commands are the CLI's, never a script of bin/ the binary runs itself", async () => {
    const cli = await Bun.file(new URL("../../../bin/sitesolide.ts", import.meta.url)).text()
    expect(cli).toContain('"  sitesolide lock   [--dry-run]')
    expect(cli).toContain('"     --new-code ')
    expect(cli).toContain('"  sitesolide unlock [--dry-run]')
    for (const code of [false, true]) for (const { command } of codeCommands(code)) expect(command).not.toContain("bin/")
  })

  test("Can open changes nothing while the site is public or opened by its code", () => {
    expect(inertNote("cms", "restricted")).toBeNull()
    expect(inertNote("cms", "public")).toContain("cms is public")
    expect(inertNote("cms", "code")).toContain("preview code")
  })
})

describe("adding someone, said before it is sent", () => {
  test("the field reads an email or a domain with its @, the steward's way", () => {
    expect(readWho("  ")).toEqual({ kind: "empty" })
    expect(readWho(" Bob@Acme.TEST ")).toEqual({ kind: "person", who: "bob@acme.test", email: "bob@acme.test" })
    expect(readWho("@acme.test")).toEqual({ kind: "domain", who: "@acme.test", domain: "acme.test" })
    expect(readWho("acme.test")).toMatchObject({ kind: "invalid", message: "For everyone at acme.test, write @acme.test." })
    expect(readWho("@com")).toMatchObject({ kind: "invalid" })
    expect(readWho("bob")).toMatchObject({ kind: "invalid" })
  })

  test("someone inside the company's domains signs in with their account and may get any role the viewer gives", () => {
    const plan = planAddition("bob@acme.test", page())
    expect(plan).toMatchObject({ state: "ready", who: "bob@acme.test", kind: "person", password: false, roles: ALL, limit: null })
    expect(plan.hint).toContain("company account")
    expect(signsInWithAccount("bob@acme.test", SIGN_IN)).toBe(true)
    // The server's own admin emails sign in wherever their domain is.
    expect(signsInWithAccount("root@else.test", SIGN_IN)).toBe(true)
  })

  test("someone outside them gets password access, Can open alone, and the hint says why before Add", () => {
    const plan = planAddition("eve@gmail.test", page())
    expect(plan).toMatchObject({ state: "ready", password: true, roles: ["visitor"], limit: "Password access can only open the site." })
    expect(plan.hint).toContain("gmail.test isn't one of the company's domains (acme.test)")
    expect(plan.hint).toContain("shown once")
  })

  test("without company sign-in, everyone gets password access, and no domain can be added", () => {
    expect(planAddition("bob@acme.test", page({ signIn: NO_SIGN_IN }))).toMatchObject({ state: "ready", password: true, roles: ["visitor"] })
    const domain = planAddition("@acme.test", page({ signIn: NO_SIGN_IN }))
    expect(domain.state).toBe("blocked")
    expect(domain.hint).toContain("Company sign-in isn't set up")
  })

  test("a domain can only open the site; an Admin adds one of the company's alone, the owner any", () => {
    expect(planAddition("@acme.test", page())).toMatchObject({ state: "ready", kind: "domain", roles: ["visitor"], limit: "A domain can only open the site: give people roles one by one." })
    expect(planAddition("@partner.test", page())).toMatchObject({ state: "ready" })
    const refused = planAddition("@partner.test", page({ you: ADMIN }))
    expect(refused).toMatchObject({ state: "blocked" })
    expect(refused.hint).toContain("Only the owner gives a domain outside the company's (acme.test)")
    expect(planAddition("@acme.test", page({ you: ADMIN })).state).toBe("ready")
  })

  test("someone already on the list is changed there, not added again", () => {
    const plan = planAddition("BOB@acme.test", page({ entries: [entry("bob@acme.test", "viewer")] }))
    expect(plan).toMatchObject({ state: "existing" })
    expect(plan.hint).toContain("already on the list, as Viewer")
  })

  test("what an empty or unfinished field says, and the limit when the viewer may give fewer roles", () => {
    expect(planAddition("", page())).toMatchObject({ state: "empty", hint: "An email, or @company.com for everyone with an account there." })
    expect(planAddition("", page({ signIn: NO_SIGN_IN })).hint).toContain("password access")
    expect(planAddition("bob@", page()).state).toBe("invalid")
    const capped = planAddition("bob@acme.test", page({ you: { kind: "person", email: "dev@acme.test", role: "developer" }, grantable: ["visitor", "viewer", "developer"] }))
    expect(capped.limit).toBe("You can give at most Developer, your own role.")
  })
})

describe("the people with access", () => {
  test("in reading order: the higher roles first, people before domains before password access, then by name", () => {
    const sorted = sortEntries([password("zed@out.test", null), entry("@acme.test"), entry("carl@acme.test"), entry("ann@acme.test", "admin"), entry("bob@acme.test", "viewer")])
    expect(sorted.map((one) => one.who)).toEqual(["ann@acme.test", "bob@acme.test", "carl@acme.test", "@acme.test", "zed@out.test"])
  })

  test("a person's row offers the roles the viewer may give, and removal when the viewer could have given theirs", () => {
    const row = entryRow(entry("bob@acme.test", "developer"), page(), NOW)
    expect(row).toMatchObject({ roles: ALL, removable: true, what: null, self: false })
    expect(row.added).toBe("Added by you, 24h ago")
    // Someone above the viewer's own role: shown, never changed.
    const developer = { you: { kind: "person", email: "dev@acme.test", role: "developer" } as Viewer, grantable: ["visitor", "viewer", "developer"] as AccessRole[] }
    expect(entryRow(entry("ann@acme.test", "admin"), page(developer), NOW)).toMatchObject({ roles: null, removable: false })
  })

  test("a domain and password access are words, not menus; an expiry near is worth a look", () => {
    expect(entryRow(entry("@acme.test"), page(), NOW)).toMatchObject({ roles: null, removable: true, what: "Everyone with a company account at acme.test" })
    expect(entryRow(password("eve@out.test", NOW + 5 * HOUR), page(), NOW)).toMatchObject({ roles: null, what: "Password access, expires in 5h", whatTone: "attention" })
    expect(entryRow(password("eve@out.test", NOW + 6 * DAY), page(), NOW)).toMatchObject({ whatTone: "neutral" })
    expect(passwordExpiry({ expiresAt: NOW - 2 * DAY, expired: true }, NOW).text).toBe("expired 2d ago")
    expect(passwordExpiry({ expiresAt: null, expired: false }, NOW).text).toBe("no expiry")
  })

  test("who gave it, quietly: you, the owner, a token, an Admin by email, nobody named for what was carried over", () => {
    expect(byText("owner", OWNER)).toBe("you")
    expect(byText("owner", ADMIN)).toBe("the owner")
    expect(byText("ann@acme.test", ADMIN)).toBe("you")
    expect(byText("token:abc", OWNER)).toBe("a token")
    expect(byText("bob@acme.test", OWNER)).toBe("bob@acme.test")
    expect(entryRow(entry("bob@acme.test", "viewer", { by: "migration" }), page(), NOW).added).toBe("Added 24h ago")
    expect(entryRow(entry("ann@acme.test", "admin"), page({ you: ADMIN }), NOW).self).toBe(true)
  })

  test("someone who does not sign in with a company account can only open the site", () => {
    expect(entryRow(entry("eve@out.test"), page(), NOW)).toMatchObject({ roles: null, what: "Can only open the site: not a company account" })
  })
})

describe("what is sent and shown after a change", () => {
  const where = { slug: "cms", url: "https://cms.test-zone.invalid/", dashboardUrl: "https://dashboard.test-zone.invalid", providerName: "Google" }

  test("the line to send: the site for Can open and a domain, the dashboard too for a role; none for password access", () => {
    expect(sendLine({ who: "bob@acme.test", kind: "person", role: "visitor" }, where)).toBe("Open https://cms.test-zone.invalid/ and sign in with your Google account.")
    expect(sendLine({ who: "@acme.test", kind: "domain", role: "visitor" }, where)).toBe("Open https://cms.test-zone.invalid/ and sign in with your Google account.")
    expect(sendLine({ who: "bob@acme.test", kind: "person", role: "developer" }, where)).toContain("in the dashboard at https://dashboard.test-zone.invalid")
    expect(sendLine({ who: "eve@out.test", kind: "password", role: "visitor" }, where)).toBeNull()
    expect(accountWords(null)).toBe("your company account")
    expect(accountWords("your company account")).toBe("your company account")
  })

  test("password access: the address, the password and the expiry, one per line; closing uncopied takes two gestures", () => {
    expect(passwordMessage("https://cms.test-zone.invalid/", "four-word-pass-phrase", Date.UTC(2026, 9, 9, 21, 3), "UTC")).toBe(
      "https://cms.test-zone.invalid/\nPassword: four-word-pass-phrase\nValid until Oct 9, 21:03",
    )
    expect(passwordMessage("https://cms.test-zone.invalid/", "p", null)).toBe("https://cms.test-zone.invalid/\nPassword: p")
    expect(closeOutcome(false, false)).toBe("warn")
    expect(closeOutcome(false, true)).toBe("close")
    expect(closeOutcome(true, false)).toBe("close")
  })

  test("the four durations are the steward's, seven days by default", async () => {
    const protocol = await Bun.file(new URL("../../src/access/protocol.ts", import.meta.url)).text()
    expect(protocol).toContain("export const PASSWORD_DURATIONS_S = [24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null] as const;")
    expect(protocol).toContain("export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600;")
    expect(PASSWORD_DURATIONS.map((option) => option.seconds)).toEqual([24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null])
    expect(PASSWORD_DURATIONS.map((option) => option.label)).toEqual(["24 hours", "7 days", "30 days", "No expiry"])
    expect(DEFAULT_PASSWORD_DURATION_S).toBe(7 * 24 * 3600)
  })

  test("a refusal is the steward's words as they stand; a portal that reads its own lists, or none, is said", () => {
    expect(refusalText(0, null)).toContain("Can't reach the dashboard")
    expect(refusalText(403, { error: "out-of-scope", message: "ann@acme.test may give at most Admin on cms" })).toBe("ann@acme.test may give at most Admin on cms")
    expect(refusalText(400, null)).toBe("Refused (400).")
    expect(readingProblem({ reading: "steward", writtenAt: NOW })).toBeNull()
    expect(readingProblem({ reading: "unknown", writtenAt: null })).toBeNull()
    expect(readingProblem({ reading: "portal", writtenAt: null })).toMatchObject({ tone: "attention" })
    expect(readingProblem({ reading: "unreadable", writtenAt: null })).toMatchObject({ tone: "error" })
  })
})
