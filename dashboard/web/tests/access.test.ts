import { describe, expect, test } from "bun:test"
import {
  ACCESS_UNREACHABLE,
  CHANGE_DURATION,
  CHANGE_SCALE_MS,
  CHANGE_SLOW_MS,
  DEFAULT_PASSWORD_DURATION_S,
  DEPLOY_NOTE,
  GENERAL_CHOICES,
  PASSWORD_DURATIONS,
  PLATFORM_SLUGS,
  addressesLine,
  byText,
  changeProgress,
  changeResult,
  changeTexts,
  closeOutcome,
  confirmationValid,
  emptyListWarning,
  generalOptions,
  generalState,
  givenText,
  guestCount,
  guestExpiry,
  inertNote,
  isExpired,
  isPlatform,
  mayRenew,
  passwordMessage,
  planGuest,
  plannedEnd,
  platformText,
  readingProblem,
  refusalText,
  removalConfirmation,
  sharedReason,
  siteAddresses,
  sortGuests,
  stewardChoices,
} from "../src/lib/access"
import type { EntryView } from "../src/lib/types"
import { site } from "./factory"

const NOW = 1_791_000_000_000
const HOUR = 3600_000
const DAY = 24 * HOUR

function guest(who: string, fields: Partial<EntryView> = {}): EntryView {
  return { who, by: "owner", createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, expiresAt: NOW + 5 * DAY, expired: false, ...fields }
}

describe("general access", () => {
  test("three ways a site opens, each with one plain sentence", () => {
    expect(GENERAL_CHOICES.map((choice) => choice.title)).toEqual(["Public", "Restricted", "Anyone with the code"])
    for (const choice of GENERAL_CHOICES) expect(choice.sentence).toMatch(/^[A-Z].*\.$/)
  })

  test("read from the snapshot: restricted with its public paths, the code with its link, public otherwise", () => {
    expect(generalState(site({ portal: { wanted: true, installed: true, exemptions: ["/api/*"] } }))).toEqual({ current: "restricted", requested: "restricted", problem: null, exemptions: ["/api/*"], code: null })
    expect(generalState(site({ lock: { closed: true, code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" } }))).toMatchObject({
      current: "code",
      code: { code: "K7PX3M", url: "https://x.test-zone.invalid/?code=K7PX3M" },
    })
    expect(generalState(site())).toEqual({ current: "public", requested: "public", problem: null, exemptions: [], code: null })
  })

  test("a disagreement with sitesolide.json comes first, and says how the server serves the site and what it asks", () => {
    const absent = generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } }))
    expect(absent).toMatchObject({ current: "public", requested: "restricted", problem: { title: "Restricted in sitesolide.json, public on the server" } })
    expect(absent.problem?.detail).toContain("Anyone can open it")
    expect(generalState(site({ portal: { wanted: false, installed: true, exemptions: [] } }))).toMatchObject({ current: "restricted", requested: "public" })
    expect(generalState(site({ lock: { closed: false, code: "AB12CD", url: null } }))).toMatchObject({ current: "code", requested: "public", problem: { detail: expect.stringContaining("Choose one below.") } })
    expect(generalState(site({ lock: { closed: true, code: null, url: null } }))).toMatchObject({ current: "public", requested: "code", problem: { detail: expect.stringContaining("Choose one below.") } })
    // No disagreement sends anyone to the command line any more.
    for (const state of [absent, generalState(site({ lock: { closed: false, code: "AB12CD", url: null } })), generalState(site({ lock: { closed: true, code: null, url: null } }))]) {
      expect(state.problem?.detail).not.toContain("folder")
    }
  })

  const allowed = stewardChoices({ access: "public", modifiable: true, reason: null, choices: { public: null, restricted: null, code: null } })

  test("any of the three may be chosen, the button naming the change", () => {
    const options = generalOptions(generalState(site()), allowed)
    expect(options.map((option) => [option.access, option.current, option.available, option.action])).toEqual([
      ["public", true, false, null],
      ["restricted", false, true, "Restrict"],
      ["code", false, true, "Use a code"],
    ])
    expect(options.every((option) => option.side === null && option.reason === null)).toBe(true)
    expect(generalOptions(generalState(site({ portal: { wanted: true, installed: true, exemptions: [] } })), allowed)[0]).toMatchObject({ available: true, action: "Make public" })
  })

  test("a site that opens with a code: Public and Restricted chosen from it, and a new code beside it", () => {
    const coded = generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } }))
    const options = generalOptions(coded, allowed)
    expect(options.map((option) => option.action)).toEqual(["Make public", "Restrict", null])
    expect(mayRenew(coded, allowed)).toBe(true)
    expect(mayRenew(coded, null)).toBe(false)
    expect(mayRenew(generalState(site()), allowed)).toBe(false)
  })

  test("a choice the steward refuses says why under it; a reason for every choice is said once", () => {
    const staticSite = stewardChoices({ access: "public", modifiable: true, reason: null, choices: { public: null, restricted: "a static site cannot be restricted yet", code: null } })
    const options = generalOptions(generalState(site()), staticSite)
    expect(options[1]).toMatchObject({ available: false, reason: "a static site cannot be restricted yet" })
    expect(options[2]).toMatchObject({ available: true, action: "Use a code", reason: null })
    expect(sharedReason(generalState(site()), staticSite)).toBeNull()
    const busy = "a portal change is in progress for this site"
    const blocked = stewardChoices({ access: "public", modifiable: false, reason: busy, choices: { public: busy, restricted: busy, code: busy } })
    expect(sharedReason(generalState(site()), blocked)).toBe(busy)
    expect(generalOptions(generalState(site()), blocked).every((option) => !option.available && option.reason === null)).toBe(true)
    expect(mayRenew(generalState(site({ lock: { closed: true, code: "K7PX3M", url: null } })), blocked)).toBe(false)
  })

  test("a steward from before the code chosen here: Public and Restricted as it said, the code pointed to the upgrade", () => {
    const older = stewardChoices({ access: "public", modifiable: true, reason: null })
    const options = generalOptions(generalState(site()), older)
    expect(options.map((option) => option.available)).toEqual([false, true, false])
    expect(options[2]!.reason).toContain("run sitesolide upgrade")
  })

  test("in disagreement, each side is marked and either may be chosen; the third stays a plain choice", () => {
    const absent = generalOptions(generalState(site({ portal: { wanted: true, installed: false, exemptions: [] } })), allowed)
    expect(absent.map((option) => [option.access, option.side, option.action])).toEqual([
      ["public", "On the server", "Keep Public"],
      ["restricted", "In sitesolide.json", "Apply Restricted"],
      ["code", null, "Use a code"],
    ])
    const extra = generalOptions(generalState(site({ portal: { wanted: false, installed: true, exemptions: [] } })), allowed)
    expect(extra.map((option) => option.action)).toEqual(["Apply Public", "Keep Restricted", "Use a code"])
    // A code in force that sitesolide.json no longer asks for: keep it, or apply Public.
    const stale = generalOptions(generalState(site({ lock: { closed: false, code: "AB12CD", url: null } })), allowed)
    expect(stale.map((option) => option.action)).toEqual(["Apply Public", "Restrict", "Keep Anyone with the code"])
    // Asked for, and no code on the server: apply it, which draws one.
    const missing = generalOptions(generalState(site({ lock: { closed: true, code: null, url: null } })), allowed)
    expect(missing.map((option) => option.action)).toEqual(["Keep Public", "Restrict", "Apply Anyone with the code"])
  })

  test("nothing to choose before the steward answers", () => {
    const state = generalState(site())
    expect(generalOptions(state, null).some((option) => option.available)).toBe(false)
    expect(stewardChoices(null)).toBeNull()
  })

  test("a platform project says why it takes no guest", () => {
    expect(platformText("portal")).toBe("portal is part of the platform. Only you open it when restricted; it takes no guest.")
  })

  test("the change says what it does in plain words; making a site public or opening it with a code retypes its slug", () => {
    expect(changeTexts("cms", "restricted")).toMatchObject({ title: "Restrict cms?", action: "Restrict", succeeded: "cms is restricted", typed: false })
    expect(changeTexts("cms", "public")).toMatchObject({ title: "Make cms public?", action: "Make public", failure: "Couldn't make cms public", typed: true })
    expect(changeTexts("cms", "public").consequence).toBe("Guests' passwords stop mattering until it is restricted again.")
    expect(changeTexts("cms", "restricted").consequence).toBe("Only you and its guests will open cms. Anyone else is asked to sign in, and refused.")
    // What it opens is said first, in red; restricting says none.
    expect(changeTexts("cms", "public").warning).toBe("Anyone with its address can open it without signing in.")
    expect(changeTexts("cms", "code")).toMatchObject({ title: "Use a code for cms?", action: "Use a code", succeeded: "cms opens with a code", typed: true })
    expect(changeTexts("cms", "code").warning).toBe("Anyone who has the code can open it, without signing in.")
    expect(changeTexts("cms", "code").consequence).toContain("shown here with a link that carries it")
    expect(changeTexts("cms", "restricted").warning).toBeNull()
    // A new code: no typing, the old one stopping said first.
    expect(changeTexts("cms", "renew")).toMatchObject({ title: "New code for cms?", action: "New code", warning: null, typed: false })
    expect(changeTexts("cms", "renew").consequence).toStartWith("The current code stops working at once")
    // Leaving a code says it stops working.
    expect(changeTexts("cms", "restricted", "code").consequence).toStartWith("Its code stops working. ")
    expect(changeTexts("cms", "public", "code").consequence).toStartWith("Its code is no longer asked. ")
    const all = [changeTexts("cms", "public"), changeTexts("cms", "restricted"), changeTexts("cms", "code"), changeTexts("cms", "renew")]
    expect(JSON.stringify(all)).not.toContain("Caddy")
    expect(JSON.stringify(all)).not.toContain("sitesolide lock")
    expect(CHANGE_DURATION).toBe("Takes up to a minute. If anything fails, nothing changes.")
    expect(confirmationValid("  cms ", "cms")).toBe(true)
    expect(removalConfirmation("  cms ")).toBe("cms")
    expect(confirmationValid("CMS", "cms")).toBe(false)
  })

  test("a site on its own domain is told the change applies there too, its preview alone is not", () => {
    const preview = site({ slug: "cms", address: "cms.test-zone.invalid" })
    expect(siteAddresses(preview)).toEqual(["cms.test-zone.invalid"])
    expect(addressesLine(siteAddresses(preview))).toBeNull()
    const pending = site({ slug: "cms", address: "cms.test-zone.invalid", domain: { name: "cms.example", aliases: [], active: false, route: false } })
    expect(siteAddresses(pending)).toEqual(["cms.test-zone.invalid"])
    const own = site({ slug: "cms", address: "cms.test-zone.invalid", domain: { name: "cms.example", aliases: [], active: true, route: true } })
    expect(siteAddresses(own)).toEqual(["cms.test-zone.invalid", "cms.example"])
    const line = "Applies to every address it answers on: cms.test-zone.invalid and cms.example."
    expect(addressesLine(siteAddresses(own))).toBe(line)
    for (const target of ["restricted", "public", "code"] as const) expect(changeTexts("cms", target, "public", siteAddresses(own)).consequence).toEndWith(` ${line}`)
    expect(changeTexts("cms", "renew", "code", siteAddresses(own)).consequence).not.toContain(line)
    expect(changeTexts("cms", "code", "public", siteAddresses(preview)).consequence).toBe(changeTexts("cms", "code").consequence)
  })

  test("restricting a site with no guest says who will still open it", () => {
    expect(emptyListWarning("wheels", 0)).toBe("wheels has no guest yet: after this, only you can open it.")
    expect(emptyListWarning("wheels", 2)).toBeNull()
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
    expect(changeResult("code", "code set: validated, reloaded, cms.example.com answers the door page's 401 and opens with its code, 4 other site(s) still answer")).toBe(
      "cms.example.com now asks for its code. The 4 other sites still answer.",
    )
    expect(changeResult("renew", "new code set: validated, reloaded, cms.example.com answers the door page's 401 and opens with the new code, not the old one, 4 other site(s) still answer")).toBe(
      "cms.example.com opens with the new code; the old one no longer does. The 4 other sites still answer.",
    )
    expect(changeResult("restricted", "portal set: validated, reloaded, cms.example.com and cms.example answer the portal's 401, 4 other site(s) still answer")).toBe(
      "cms.example.com and cms.example now ask visitors to sign in. The 4 other sites still answer.",
    )
    expect(changeResult("code", "code set: validated, reloaded, cms.example.com and cms.example answer the door page's 401 and open with its code, 4 other site(s) still answer")).toBe(
      "cms.example.com and cms.example now ask for its code. The 4 other sites still answer.",
    )
    expect(changeResult("restricted", "something else")).toBe("something else")
    expect(DEPLOY_NOTE).toBe("Your next sitesolide deploy writes this into sitesolide.json.")
  })

  /** The words of the gatekeeper the page reads are its own: a change of them there must show here. */
  test("the verdict the page reads is the gatekeeper's own wording", async () => {
    const transaction = await Bun.file(new URL("../../src/gatekeeper/transaction.ts", import.meta.url)).text()
    expect(transaction).toContain("`${words}: validated, reloaded, ${checked}, ${others} other site(s) still answer${tail}`")
    expect(transaction).toContain('const site = `${targets.join(" and ")} ${targets.length > 1 ? "answer" : "answers"}`;')
    expect(transaction).toContain("`${site} the portal's 401`")
    expect(transaction).toContain("`${site} the door page's 401 and ${targets.length > 1 ? \"open\" : \"opens\"} with its code`")
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

  test("guests change nothing while the site is public or opened by its code", () => {
    expect(inertNote("cms", "restricted")).toBeNull()
    expect(inertNote("wheels", "public")).toBe("wheels is public: guests' passwords only matter once it's restricted.")
    expect(inertNote("cms", "code")).toBe("cms opens with its preview code: guests' passwords only matter once it's restricted.")
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

describe("guests", () => {
  test("the field reads an email the steward's way; a domain is refused, and a guest already there is said", () => {
    const entries = [guest("ann@acme.test")]
    expect(planGuest("  ", entries)).toMatchObject({ state: "empty", who: null })
    expect(planGuest(" Bob@Acme.Test ", entries)).toMatchObject({ state: "ready", who: "bob@acme.test" })
    expect(planGuest("@acme.test", entries)).toMatchObject({ state: "invalid", who: null, hint: expect.stringContaining("whole domain") })
    expect(planGuest("bob", entries)).toMatchObject({ state: "invalid", who: null })
    expect(planGuest("ANN@acme.test", entries)).toEqual({ state: "existing", who: "ann@acme.test", hint: "ann@acme.test is already a guest." })
  })

  test("who gave it, quietly: you, a token, an email; nothing for what was carried over", () => {
    expect(byText("owner")).toBe("you")
    expect(byText("token:abc")).toBe("a token")
    expect(byText("ann@acme.test")).toBe("ann@acme.test")
    expect(byText("migration")).toBeNull()
    expect(givenText(guest("a@acme.test"), NOW)).toBe("Given by you, 3d ago")
    expect(givenText(guest("a@acme.test", { by: "migration" }), NOW)).toBe("Given 3d ago")
  })

  test("an expiry in words, worth a look within a day; one that ended says Expired", () => {
    expect(guestExpiry(guest("a@acme.test"), NOW)).toEqual({ text: "Expires in 5d", tone: "neutral" })
    expect(guestExpiry(guest("a@acme.test", { expiresAt: NOW + 2 * HOUR }), NOW)).toEqual({ text: "Expires in 2h", tone: "attention" })
    expect(guestExpiry(guest("a@acme.test", { expiresAt: NOW - 2 * DAY, expired: true }), NOW)).toEqual({ text: "Expired 2d ago", tone: "neutral" })
    expect(guestExpiry(guest("a@acme.test", { expiresAt: null }), NOW)).toEqual({ text: "No expiry", tone: "neutral" })
    // Past its time, an access has ended even before the steward says so.
    expect(isExpired(guest("a@acme.test", { expiresAt: NOW - 1 }), NOW)).toBe(true)
    expect(isExpired(guest("a@acme.test", { expiresAt: null }), NOW)).toBe(false)
  })

  test("in reading order: those who still open the site first, then by name", () => {
    const ended = guest("aaron@acme.test", { expiresAt: NOW - DAY, expired: true })
    const list = [guest("zoe@acme.test"), ended, guest("bob@acme.test", { expiresAt: null })]
    expect(sortGuests(list, NOW).map((one) => one.who)).toEqual(["bob@acme.test", "zoe@acme.test", "aaron@acme.test"])
    expect(list[0]!.who).toBe("zoe@acme.test")
  })

  test("the Overview counts guests in a few words", () => {
    expect(guestCount(0)).toBe("No guests")
    expect(guestCount(1)).toBe("1 guest")
    expect(guestCount(4)).toBe("4 guests")
  })

  test("the message: the address, the password and the expiry, one per line; closing uncopied takes two gestures", () => {
    expect(passwordMessage("https://cms.test-zone.invalid/", "four-word-pass-phrase", Date.UTC(2026, 9, 9, 21, 3), "UTC")).toBe(
      "https://cms.test-zone.invalid/\nPassword: four-word-pass-phrase\nValid until Oct 9, 21:03 UTC",
    )
    expect(passwordMessage("https://cms.test-zone.invalid/", "p", null)).toBe("https://cms.test-zone.invalid/\nPassword: p")
    expect(closeOutcome(false, false)).toBe("warn")
    expect(closeOutcome(false, true)).toBe("close")
    expect(closeOutcome(true, false)).toBe("close")
  })

  test("the chosen duration's end, said before giving access", () => {
    expect(plannedEnd(null, NOW)).toBe("Valid until you remove it.")
    expect(plannedEnd(3600, Date.UTC(2026, 9, 9, 20, 3), "UTC")).toBe("Valid until Oct 9, 21:03 UTC.")
  })

  test("the four durations are the steward's, seven days by default", async () => {
    const protocol = await Bun.file(new URL("../../src/access/protocol.ts", import.meta.url)).text()
    expect(protocol).toContain("export const PASSWORD_DURATIONS_S = [24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null] as const;")
    expect(protocol).toContain("export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600;")
    expect(PASSWORD_DURATIONS.map((option) => option.seconds)).toEqual([24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null])
    expect(PASSWORD_DURATIONS.map((option) => option.label)).toEqual(["24 hours", "7 days", "30 days", "No expiry"])
    expect(DEFAULT_PASSWORD_DURATION_S).toBe(7 * 24 * 3600)
  })

  test("a refusal is the steward's words as they stand; a portal that reads no list is said", () => {
    expect(refusalText(0, null)).toContain("Can't reach the dashboard")
    expect(ACCESS_UNREACHABLE).not.toContain("steward")
    expect(refusalText(403, { error: "out-of-scope", message: "a reason from the steward" })).toBe("a reason from the steward")
    expect(refusalText(400, null)).toBe("Refused (400).")
    expect(readingProblem({ reading: "steward", writtenAt: NOW })).toBeNull()
    expect(readingProblem({ reading: "unknown", writtenAt: null })).toBeNull()
    expect(readingProblem({ reading: "unreadable", writtenAt: null })).toMatchObject({ tone: "error" })
  })
})
