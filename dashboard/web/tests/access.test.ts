import { describe, expect, test } from "bun:test"
import {
  ACCESS_UNREACHABLE,
  CHANGE_DURATION,
  CHANGE_SCALE_MS,
  CHANGE_SLOW_MS,
  DEFAULT_PASSWORD_DURATION_S,
  DEPLOY_NOTE,
  GENERAL_CHOICES,
  LADDER,
  PASSWORD_DURATIONS,
  PLATFORM_SLUGS,
  ROLE_TEXTS,
  accessSummary,
  accountWords,
  alsoOpens,
  askAnAdmin,
  byText,
  changeProgress,
  changeResult,
  changeTexts,
  closeOutcome,
  codeCommands,
  confirmationValid,
  emptyListWarning,
  entryRow,
  generalLine,
  generalNote,
  generalOptions,
  generalState,
  grantSentence,
  inertNote,
  isPlatform,
  leavingWarning,
  unlockLine,
  lowers,
  needsUnlock,
  passwordExpiry,
  passwordMessage,
  platformText,
  planAddition,
  raiseNeedsUnlock,
  readWho,
  readingProblem,
  refusalText,
  removalConfirmation,
  roleLabel,
  rolesSummary,
  selfChangeWarning,
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
  test("one ladder, from Can open to Admin, each in the spec's words, each including the ones below", () => {
    expect(LADDER).toEqual(ALL)
    expect(ALL.map(roleLabel)).toEqual(["Can open", "Viewer", "Developer", "Admin"])
    // The owner is no rung: they are above every project, on no list.
    expect(Object.keys(ROLE_TEXTS)).toEqual(ALL)
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
    expect(lowers("admin", "developer")).toBe(true)
    expect(lowers("viewer", "admin")).toBe(false)
  })
})

describe("general access", () => {
  test("three ways a site opens, each with one plain sentence", () => {
    expect(GENERAL_CHOICES.map((choice) => choice.title)).toEqual(["Public", "Restricted", "Anyone with the code"])
    for (const choice of GENERAL_CHOICES) expect(choice.sentence).toMatch(/^[A-Z].*\.$/)
  })

  test("read from the snapshot: restricted with its public paths, the code with its link, public otherwise", () => {
    expect(generalState(site({ portal: { wanted: true, installed: true, exemptions: ["/api/*"] } }))).toEqual({ current: "restricted", problem: null, exemptions: ["/api/*"], code: null, requested: true })
    expect(generalState(site({ lock: { closed: true, code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" } }))).toMatchObject({
      current: "code",
      code: { code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" },
    })
    expect(generalState(site())).toEqual({ current: "public", problem: null, exemptions: [], code: null, requested: false })
  })

  test("a disagreement with sitesolide.json comes first, and says how the server serves the site", () => {
    const absent = generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } }))
    expect(absent.current).toBe("public")
    expect(absent.problem).toMatchObject({ portal: true, title: "Restricted in sitesolide.json, public on the server" })
    expect(absent.problem?.detail).toContain("Anyone can open it")
    expect(generalState(site({ portal: { wanted: false, installed: true, exemptions: [] } }))).toMatchObject({ current: "restricted", problem: { portal: true } })
    expect(generalState(site({ lock: { closed: false, code: "AB12CD", url: null } }))).toMatchObject({ current: "code", problem: { portal: false } })
    expect(generalState(site({ lock: { closed: true, code: null, url: null } }))).toMatchObject({ current: "public", problem: { portal: false } })
  })

  const modifiable = { modifiable: true, reason: null }

  test("an Admin or the owner switches between public and restricted, the button naming the change; no row carries a command", () => {
    const options = generalOptions(generalState(site()), modifiable, true)
    expect(options.map((option) => [option.access, option.current, option.available, option.action])).toEqual([
      ["public", true, false, null],
      ["restricted", false, true, "Restrict"],
      ["code", false, false, null],
    ])
    expect(options.every((option) => option.side === null)).toBe(true)
    expect(generalOptions(generalState(site({ portal: { wanted: true, installed: true, exemptions: [] } })), modifiable, true)[0]).toMatchObject({ available: true, action: "Make public" })
  })

  test("the preview code is said once, under the choices, by who reads it", () => {
    const open = generalState(site())
    const coded = generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } }))
    expect(generalNote(open, "owner")).toBe("A preview code is set with sitesolide lock, in the project's folder.")
    expect(generalNote(open, "admin")).toBe("Only the owner sets a preview code.")
    // Once removed, the site opens as sitesolide.json says: said with the way to remove it.
    expect(generalNote(coded, "owner")).toBe("To make it public or restricted, remove the code first: sitesolide unlock, in the project's folder. It then opens as sitesolide.json says: Public.")
    expect(generalNote({ ...coded, requested: true }, "owner")).toEndWith("It then opens as sitesolide.json says: Restricted.")
    expect(generalNote(coded, "admin")).toBe("Only the owner removes the code; ask them, then restrict it here.")
    expect(generalNote(open, "reader")).toBeNull()
  })

  test("while a code is set, public and restricted wait for it to be removed, with the CLI's commands", () => {
    const options = generalOptions(generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } })), modifiable, true)
    expect(options.filter((option) => option.available)).toEqual([])
    expect(codeCommands(true).map((command) => command.command)).toEqual(["sitesolide lock --new-code", "sitesolide unlock"])
    expect(codeCommands(false)).toEqual([{ label: "Give it a preview code", command: "sitesolide lock" }])
  })

  test("in disagreement, each side is marked and either may be chosen: keep the server's, or apply sitesolide.json's", () => {
    const absent = generalOptions(generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } })), modifiable, true)
    expect(absent.map((option) => [option.access, option.side, option.action])).toEqual([
      ["public", "On the server", "Keep Public"],
      ["restricted", "In sitesolide.json", "Apply Restricted"],
      ["code", null, null],
    ])
    const extra = generalOptions(generalState(site({ portal: { wanted: false, installed: true, exemptions: [] } })), modifiable, true)
    expect(extra.map((option) => option.action)).toEqual(["Apply Public", "Keep Restricted", null])
  })

  test("nothing to choose for a Viewer or a Developer, nor before the steward answers, nor when it refuses", () => {
    const state = generalState(site())
    expect(generalOptions(state, modifiable, false).some((option) => option.available)).toBe(false)
    expect(generalOptions(state, null, true).some((option) => option.available)).toBe(false)
    expect(generalOptions(state, { modifiable: false, reason: "Caddy's lock is held" }, true).some((option) => option.available)).toBe(false)
  })

  test("whoever only reads it gets one line: how the site opens, and who changes it", () => {
    expect(generalLine(generalState(site({ portal: { wanted: true, installed: true, exemptions: [] } })), "cms")).toBe(
      "Restricted: only the people with access can open it, once signed in. Only an Admin of cms, or the owner, changes it.",
    )
    expect(generalLine(generalState(site()), "cms")).toBe("Public: anyone with the address can open the site. Only an Admin of cms, or the owner, changes it.")
    expect(generalLine(generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } })), "cms")).toStartWith("Anyone with the code: the preview code opens it.")
    // A platform project: nobody but the owner has a say, so the line says how it opens, alone.
    expect(generalLine(generalState(site()), "portal", true)).toBe("Public: anyone with the address can open the site.")
    expect(platformText("portal")).toBe("portal is part of the platform. Only the owner opens it when restricted; no one can be given a role on it.")
  })

  test("the change says what it does in plain words; making a site public retypes its slug, without the blanks of an entry", () => {
    expect(changeTexts("cms", "restricted")).toMatchObject({ title: "Restrict cms?", action: "Restrict", succeeded: "cms is restricted" })
    expect(changeTexts("cms", "public")).toMatchObject({ title: "Make cms public?", action: "Make public", failure: "Couldn't make cms public" })
    expect(changeTexts("cms", "public").consequence).toBe("People with access keep their dashboard roles; Can open and password access stop mattering.")
    // What making it public opens is said first, in red; restricting says none.
    expect(changeTexts("cms", "public").warning).toBe("Anyone with its address can open it without signing in.")
    expect(changeTexts("cms", "restricted").warning).toBeNull()
    expect(JSON.stringify([changeTexts("cms", "public"), changeTexts("cms", "restricted")])).not.toContain("Caddy")
    expect(CHANGE_DURATION).toBe("Takes up to a minute. If anything fails, nothing changes.")
    expect(confirmationValid("  cms ", "cms")).toBe(true)
    expect(removalConfirmation("  cms ")).toBe("cms")
    expect(confirmationValid("CMS", "cms")).toBe(false)
  })

  test("restricting a site nobody is on the list of says who will still open it", () => {
    expect(emptyListWarning("wheels", 0, ["owner@acme.test"])).toBe("Nobody is on the list yet: after this, only the owner and the admin emails can open wheels.")
    expect(emptyListWarning("wheels", 0, [])).toBe("Nobody is on the list yet: after this, only the owner can open wheels.")
    expect(emptyListWarning("wheels", 2, [])).toBeNull()
  })

  test("the gatekeeper's verdict, in plain words; anything else as it stands", () => {
    expect(changeResult("restricted", "portal set: validated, reloaded, wheels.example.com answers the portal's 401, 13 other site(s) still answer")).toBe(
      "wheels.example.com now asks visitors to sign in. The 13 other sites still answer.",
    )
    expect(changeResult("public", "portal removed: validated, reloaded, calendar.example.com answers without the portal, 1 other site(s) still answer")).toBe(
      "calendar.example.com now opens without signing in. The other site still answers.",
    )
    expect(changeResult("public", "portal removed: validated, reloaded, a.example.com answers without the portal, 0 other site(s) still answer; already not answering before: b, c")).toBe(
      "a.example.com now opens without signing in. Already not answering before: b, c.",
    )
    expect(changeResult("restricted", "something else")).toBe("something else")
    expect(DEPLOY_NOTE).toBe("Your next sitesolide deploy writes this into sitesolide.json.")
  })

  /** The words of the gatekeeper the page reads are its own: a change of them there must show here. */
  test("the verdict the page reads is the gatekeeper's own wording", async () => {
    const transaction = await Bun.file(new URL("../../src/gatekeeper/transaction.ts", import.meta.url)).text()
    expect(transaction).toContain("`${action}: validated, reloaded, ${checked}, ${others} other site(s) still answer${tail}`")
    expect(transaction).toContain("`${target} answers the portal's 401`")
    expect(transaction).toContain("already not answering before: ")
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
    expect(inertNote("cms", "restricted", true)).toBeNull()
    expect(inertNote("wheels", "public", true)).toBe("wheels is public, so anyone can open it. Viewer, Developer and Admin still apply; Can open matters once you restrict it.")
    expect(inertNote("wheels", "public", false)).toEndWith("once it's restricted.")
    expect(inertNote("cms", "code", true)).toContain("preview code")
  })

  test("the platform's own projects are the steward's list, the landing included", async () => {
    const policy = await Bun.file(new URL("../../src/control/policy.ts", import.meta.url)).text()
    expect(policy).toContain(`export const RESERVED_SLUGS: readonly string[] = ${JSON.stringify(PLATFORM_SLUGS).replaceAll(",", ", ")};`)
    expect(isPlatform("portal", "example.com")).toBe(true)
    expect(isPlatform("example.com", "example.com")).toBe(true)
    expect(isPlatform("cms", "example.com")).toBe(false)
    expect(isPlatform("cms", null)).toBe(false)
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
    expect(plan).toMatchObject({ state: "ready", who: "bob@acme.test", kind: "person", password: false, roles: ALL, covered: null })
    expect(plan.hint).toContain("company account")
    expect(signsInWithAccount("bob@acme.test", SIGN_IN)).toBe(true)
    // The server's own admin emails sign in wherever their domain is.
    expect(signsInWithAccount("root@else.test", SIGN_IN)).toBe(true)
  })

  test("someone outside them gets password access, Can open alone, said in one short sentence before Add", () => {
    const plan = planAddition("eve@gmail.test", page())
    expect(plan).toMatchObject({ state: "ready", password: true, roles: ["visitor"] })
    expect(plan.hint).toBe("gmail.test isn't one of the company's domains: they get password access, to open the site only.")
  })

  test("without company sign-in, everyone gets password access, and no domain can be added", () => {
    expect(planAddition("bob@acme.test", page({ signIn: NO_SIGN_IN }))).toMatchObject({ state: "ready", password: true, roles: ["visitor"] })
    const domain = planAddition("@acme.test", page({ signIn: NO_SIGN_IN }))
    expect(domain.state).toBe("blocked")
    expect(domain.hint).toContain("Company sign-in isn't set up")
  })

  test("a domain can only open the site, and is one of the company's for everyone, the owner included; with none listed, any", () => {
    expect(planAddition("@acme.test", page())).toMatchObject({ state: "ready", kind: "domain", roles: ["visitor"] })
    for (const you of [undefined, ADMIN]) {
      const refused = planAddition("@partner.test", page(you === undefined ? {} : { you }))
      expect(refused).toMatchObject({ state: "blocked" })
      expect(refused.hint).toBe("Nobody at partner.test can sign in here: only acme.test accounts can. Add people from partner.test by email: they get password access.")
    }
    const two = planAddition("@partner.test", page({ signIn: { ...SIGN_IN, allowedDomains: ["acme.test", "acme.example"] } }))
    expect(two.hint).toContain("only acme.test or acme.example accounts can")
    expect(planAddition("@acme.test", page({ you: ADMIN })).state).toBe("ready")
    expect(planAddition("@partner.test", page({ signIn: { ...page().signIn, allowedDomains: [] } })).state).toBe("ready")
  })

  test("someone a domain on the list already covers, or an admin email, is said to open the site already", () => {
    expect(planAddition("bob@acme.test", page({ entries: [entry("@acme.test")] })).covered).toBe("Already covered by @acme.test.")
    expect(planAddition("root@else.test", page()).covered).toBe("root@else.test already opens every site, as admin: it's set on the server.")
    expect(planAddition("eve@gmail.test", page({ entries: [entry("@acme.test")] })).covered).toBeNull()
  })

  test("someone already on the list is changed there, not added again", () => {
    const plan = planAddition("BOB@acme.test", page({ entries: [entry("bob@acme.test", "viewer")] }))
    expect(plan).toMatchObject({ state: "existing" })
    expect(plan.hint).toContain("already on the list, as Viewer")
  })

  test("what an empty or unfinished field says", () => {
    expect(planAddition("", page())).toMatchObject({ state: "empty", hint: "An email, or @company.com for everyone with an account there." })
    expect(planAddition("", page({ signIn: NO_SIGN_IN })).hint).toContain("password access")
    expect(planAddition("bob@", page()).state).toBe("invalid")
  })
})

describe("the people with access", () => {
  test("in reading order: the higher roles first, people before domains before password access, then by name; what expired last", () => {
    const sorted = sortEntries(
      [password("old@out.test", NOW - DAY), password("zed@out.test", null), entry("@acme.test"), entry("carl@acme.test"), entry("ann@acme.test", "admin"), entry("bob@acme.test", "viewer")],
      NOW,
    )
    expect(sorted.map((one) => one.who)).toEqual(["ann@acme.test", "bob@acme.test", "carl@acme.test", "@acme.test", "zed@out.test", "old@out.test"])
  })

  test("a person's row offers the roles the viewer may give, and removal when the viewer could have given theirs", () => {
    const row = entryRow(entry("bob@acme.test", "developer"), page(), NOW)
    expect(row).toMatchObject({ roles: ALL, removable: true, what: null, self: false, word: "Developer", muted: false })
    expect(row.added).toBe("Added by you, 24h ago")
  })

  test("a Viewer or a Developer reads every row as words, with nothing to change", () => {
    const reader = { you: { kind: "person", email: "dev@acme.test", role: "developer" } as Viewer, grantable: [] as AccessRole[] }
    for (const one of [entry("ann@acme.test", "admin"), entry("bob@acme.test"), entry("@acme.test"), password("eve@out.test", null)]) {
      expect(entryRow(one, page(reader), NOW)).toMatchObject({ roles: null, removable: false })
    }
    expect(askAnAdmin([entry("ann@acme.test", "admin"), entry("bo@acme.test", "admin"), entry("cy@acme.test", "viewer")])).toBe("To add someone, ask an Admin: ann@acme.test, bo@acme.test.")
    expect(askAnAdmin([entry("cy@acme.test", "viewer")])).toBe("To add someone, ask the owner.")
  })

  test("a domain and password access are words, not menus; an expiry near is worth a look; one that ended says Expired, greyed", () => {
    expect(entryRow(entry("@acme.test"), page(), NOW)).toMatchObject({ roles: null, removable: true, what: "Everyone with a company account at acme.test", word: "Can open" })
    expect(entryRow(password("eve@out.test", NOW + 5 * HOUR), page(), NOW)).toMatchObject({ roles: null, what: "Password access, expires in 5h", whatTone: "attention", word: "Can open" })
    expect(entryRow(password("eve@out.test", NOW + 6 * DAY), page(), NOW)).toMatchObject({ whatTone: "neutral" })
    expect(entryRow(password("eve@out.test", NOW - 2 * DAY), page(), NOW)).toMatchObject({ word: "Expired", muted: true, removable: true, what: "Password access, expired 2d ago" })
    expect(passwordExpiry({ expiresAt: NOW - 2 * DAY, expired: true }, NOW).text).toBe("expired 2d ago")
    expect(passwordExpiry({ expiresAt: null, expired: false }, NOW).text).toBe("no expiry")
  })

  test("who gave it, quietly: you, the owner, a token, an Admin by email; nothing for what was carried over", () => {
    expect(byText("owner", OWNER)).toBe("you")
    expect(byText("owner", ADMIN)).toBe("the owner")
    expect(byText("ann@acme.test", ADMIN)).toBe("you")
    expect(byText("token:abc", OWNER)).toBe("a token")
    expect(byText("bob@acme.test", OWNER)).toBe("bob@acme.test")
    expect(entryRow(entry("bob@acme.test", "viewer", { by: "migration" }), page(), NOW).added).toBeNull()
    expect(entryRow(entry("ann@acme.test", "admin"), page({ you: ADMIN }), NOW).self).toBe(true)
  })

  test("someone who can't sign in keeps their role, greyed, and says why", () => {
    expect(entryRow(entry("eve@out.test"), page(), NOW)).toMatchObject({ roles: null, muted: true, what: "Can't sign in: out.test isn't one of the company's domains." })
    expect(entryRow(entry("bob@acme.test", "developer"), page({ signIn: NO_SIGN_IN }), NOW)).toMatchObject({
      roles: null,
      word: "Developer",
      muted: true,
      removable: true,
      what: "Can't sign in until company sign-in is set up.",
    })
    expect(entryRow(entry("@acme.test"), page({ signIn: NO_SIGN_IN }), NOW)).toMatchObject({ word: "Can open", muted: true, what: "Can't sign in until company sign-in is set up." })
  })

  test("who opens the site without being on its list, said once under it", () => {
    expect(alsoOpens(["owner@acme.test"])).toBe("Also open it: the owner, and owner@acme.test (an admin email set on the server; sites see them as admin).")
    expect(alsoOpens(["a@acme.test", "b@acme.test"])).toBe("Also open it: the owner, and a@acme.test, b@acme.test (admin emails set on the server; sites see them as admin).")
    expect(alsoOpens([])).toBe("The owner also opens it.")
  })

  test("what someone has now, in one sentence; an Admin giving up their own role is told first", () => {
    expect(grantSentence("dana@acme.test", "visitor", "cms")).toBe("dana@acme.test can now open cms.")
    expect(grantSentence("dana@acme.test", "viewer", "cms")).toBe("dana@acme.test is now Viewer on cms.")
    expect(selfChangeWarning("cms")).toBe("You'll no longer manage cms. Only another Admin or the owner can give it back.")
  })

  test("the Overview counts people and domains", () => {
    expect(accessSummary([entry("a@acme.test"), entry("b@acme.test", "admin"), password("c@out.test", null), entry("@acme.test")])).toBe("3 people and 1 domain have access")
    expect(accessSummary([entry("a@acme.test")])).toBe("1 person has access")
    expect(accessSummary([entry("@acme.test"), entry("@acme.example")])).toBe("2 domains have access")
    expect(accessSummary([])).toBe("Nobody is on the list yet")
  })
})

describe("a lowering or a removal that takes someone out of the dashboard", () => {
  const tokens = [
    { id: "aaaaaaaaaaaa", label: "alice-ci", madeBy: "them" as const },
    { id: "bbbbbbbbbbbb", label: "Alice's laptop", madeBy: "owner" as const },
  ]
  const owner = { you: { kind: "owner" as const }, leaving: { "chloe@example.com": tokens, "dan@example.com": [] } }

  test("said before it is done, with the tokens it revokes and who made each", () => {
    expect(leavingWarning("chloe@example.com", "visitor", owner)).toBe(
      "chloe@example.com will no longer sign in to the dashboard. Also revokes 2 tokens: alice-ci (made by them), Alice's laptop (made by you).",
    )
    expect(leavingWarning("chloe@example.com", null, owner)).toStartWith("chloe@example.com will no longer sign in")
    expect(leavingWarning("dan@example.com", null, owner)).toBe("dan@example.com will no longer sign in to the dashboard.")
    // An Admin reads the owner's tokens as the owner's.
    const admin = { ...owner, you: { kind: "person" as const, email: "ann@example.com", role: "admin" as const } }
    expect(leavingWarning("chloe@example.com", "visitor", admin)).toContain("Alice's laptop (made by the owner)")
    // Oneself, in the second person.
    const self = { leaving: { "ann@example.com": [tokens[0]!] }, you: { kind: "person" as const, email: "ann@example.com", role: "admin" as const } }
    expect(leavingWarning("ann@example.com", null, self)).toBe("You will no longer sign in to the dashboard. Also revokes 1 token: alice-ci (made by you).")
  })

  test("nothing said when they keep a role above Can open, or the steward names nobody", () => {
    expect(leavingWarning("chloe@example.com", "viewer", owner)).toBeNull()
    expect(leavingWarning("bob@example.com", "visitor", owner)).toBeNull()
    expect(leavingWarning("chloe@example.com", "visitor", { ...owner, leaving: {} })).toBeNull()
  })

  test("what waits for the unlock, in the button's words", () => {
    expect(unlockLine("developer", false)).toBe("Giving Developer needs Unlock changes first.")
    expect(unlockLine("visitor", true)).toBe("Password access needs Unlock changes first.")
  })
})

describe("what is sent and shown after a change", () => {
  const where = { slug: "cms", url: "https://cms.test-zone.invalid/", dashboardUrl: "https://dashboard.test-zone.invalid", providerName: "Google" }

  test("the line to send: the site for Can open and a domain, the dashboard too for a role; none for password access", () => {
    expect(sendLine({ who: "bob@acme.test", kind: "person", role: "visitor" }, where)).toBe("Open https://cms.test-zone.invalid/ and sign in with your Google account.")
    expect(sendLine({ who: "@acme.test", kind: "domain", role: "visitor" }, where)).toBe("Open https://cms.test-zone.invalid/ and sign in with your Google account.")
    expect(sendLine({ who: "bob@acme.test", kind: "person", role: "viewer" }, where)).toBe(
      "cms is at https://cms.test-zone.invalid/, and in the dashboard at https://dashboard.test-zone.invalid. Sign in with your Google account.",
    )
    // Developer and Admin deploy: how, said with the rest.
    for (const role of ["developer", "admin"] as const) {
      expect(sendLine({ who: "bob@acme.test", kind: "person", role }, where)).toBe(
        "cms is at https://cms.test-zone.invalid/, and in the dashboard at https://dashboard.test-zone.invalid. Sign in with your Google account. To deploy, create a token on the Tokens page, then run sitesolide login --url https://dashboard.test-zone.invalid.",
      )
    }
    expect(sendLine({ who: "eve@out.test", kind: "password", role: "visitor" }, where)).toBeNull()
    expect(accountWords(null)).toBe("your company account")
    expect(accountWords("your company account")).toBe("your company account")
  })

  test("password access: the address, the password and the expiry, one per line; closing uncopied takes two gestures", () => {
    expect(passwordMessage("https://cms.test-zone.invalid/", "four-word-pass-phrase", Date.UTC(2026, 9, 9, 21, 3), "UTC")).toBe(
      "https://cms.test-zone.invalid/\nPassword: four-word-pass-phrase\nValid until Oct 9, 21:03 UTC",
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
    expect(ACCESS_UNREACHABLE).not.toContain("steward")
    expect(refusalText(403, { error: "out-of-scope", message: "ann@acme.test may give at most Admin on cms" })).toBe("ann@acme.test may give at most Admin on cms")
    expect(refusalText(400, null)).toBe("Refused (400).")
    expect(readingProblem({ reading: "steward", writtenAt: NOW })).toBeNull()
    expect(readingProblem({ reading: "unknown", writtenAt: null })).toBeNull()
    expect(readingProblem({ reading: "portal", writtenAt: null })).toMatchObject({ tone: "attention" })
    expect(readingProblem({ reading: "unreadable", writtenAt: null })).toMatchObject({ tone: "error" })
  })
})
