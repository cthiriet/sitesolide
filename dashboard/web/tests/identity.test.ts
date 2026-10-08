import { describe, expect, test } from "bun:test"
import { isAdminOf, isPerson, mayRestart, reauthUrl, roleOn, signInFailure, signInUrl, unlockFailure } from "../src/lib/identity"
import { MACHINE_PAGES, SECTIONS, machinePagesFor, mayOpen, pageFromUrl, sectionsFor } from "../src/lib/pages"
import { auditWords } from "../src/lib/audit"
import type { AuditRow, IdentityView } from "../src/lib/types"

const OWNER: IdentityView = { kind: "owner" }
const ALICE: IdentityView = { kind: "person", email: "alice@acme.test", name: null, roles: { blog: "developer", shop: "viewer", cms: "admin" }, create: false, expiresAt: 0 }
/** A Viewer everywhere, without the create right: nothing to mint. */
const VIC: IdentityView = { kind: "person", email: "vic@acme.test", name: null, roles: { shop: "viewer" }, create: false, expiresAt: 0 }

describe("what a person sees of the page", () => {
  test("Sites, Activity, Tokens when they may mint one; in a site, the sections their role opens, Access for every role", () => {
    expect(machinePagesFor(ALICE).map((entry) => entry.name)).toEqual(["home", "activity", "tokens"])
    expect(machinePagesFor(VIC).map((entry) => entry.name)).toEqual(["home", "activity"])
    expect(machinePagesFor({ ...VIC, create: true } as IdentityView).map((entry) => entry.name)).toEqual(["home", "activity", "tokens"])
    expect(sectionsFor(ALICE, "shop").map((entry) => entry.section)).toEqual(["overview", "audience", "access"])
    expect(sectionsFor(ALICE, "blog").map((entry) => entry.section)).toEqual(["overview", "audience", "secrets", "access"])
    expect(sectionsFor(ALICE, "cms").map((entry) => entry.section)).toEqual(["overview", "audience", "secrets", "access", "backups"])
    expect(machinePagesFor(OWNER)).toEqual(MACHINE_PAGES)
    expect(machinePagesFor(OWNER).map((entry) => entry.title)).toEqual(["Sites", "Activity", "People", "Tokens", "Connectors"])
    expect(sectionsFor(null, "blog")).toEqual(SECTIONS)
    expect(SECTIONS.map((entry) => entry.title)).toEqual(["Overview", "Audience", "Secrets", "Access", "Backups"])
  })

  test("a page that is not theirs, reached by its address, says so", () => {
    for (const path of ["/people/", "/connectors/", "/members/"]) expect(mayOpen(pageFromUrl(path), ALICE)).toBe(false)
    expect(mayOpen(pageFromUrl("/tokens/"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/tokens/"), VIC)).toBe(false)
    expect(mayOpen(pageFromUrl("/site/secrets/", "?s=shop"), ALICE)).toBe(false)
    expect(mayOpen(pageFromUrl("/site/secrets/", "?s=blog"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/site/access/", "?s=shop"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/site/backups/", "?s=blog"), ALICE)).toBe(false)
    expect(mayOpen(pageFromUrl("/people/"), OWNER)).toBe(true)
  })

  test("the role on a project, an Admin's, and the restart for a Developer and an Admin on their own projects", () => {
    expect(isPerson(ALICE) && !isPerson(OWNER) && !isPerson(null)).toBe(true)
    expect(roleOn(ALICE, "blog")).toBe("developer")
    expect(roleOn(ALICE, "nowhere")).toBeNull()
    expect(roleOn(OWNER, "blog")).toBeNull()
    expect(isAdminOf(ALICE, "cms")).toBe(true)
    expect(isAdminOf(ALICE, "blog")).toBe(false)
    expect(mayRestart(ALICE, "blog")).toBe(true)
    expect(mayRestart(ALICE, "shop")).toBe(false)
    expect(mayRestart(OWNER, "blog")).toBe(false)
  })
})

describe("a person's unlock and sign-in", () => {
  test("the unlock leaves for a forced sign-in and comes back to the page, a previous refusal's note left off", () => {
    expect(reauthUrl("/site/secrets/", "?s=blog&unlock=refused")).toBe("/api/sso/begin?reauth=1&return=%2Fsite%2Fsecrets%2F%3Fs%3Dblog")
    expect(reauthUrl("/site/access/", "")).toBe("/api/sso/begin?reauth=1&return=%2Fsite%2Faccess%2F")
  })

  test("an unlock or a sign-in that came back without a session says why in words", () => {
    expect(unlockFailure(null)).toBeNull()
    expect(unlockFailure("refused")).toContain("didn't confirm")
    expect(unlockFailure("nothing-to-unlock")).toContain("Viewer on every project")
    expect(unlockFailure("whatever")).toContain("isn't available")
    expect(signInUrl("/site/?s=blog")).toBe("/api/sso/begin?return=%2Fsite%2F%3Fs%3Dblog")
    expect(signInUrl("/", true)).toBe("/api/sso/begin?return=%2F&account=choose")
    expect(signInFailure(null)).toBeNull()
    expect(signInFailure("no-role")).toBe("This account has no access to any project here. Ask the owner, or an Admin of the project, to add you.")
    expect(signInFailure("not-a-member")).toContain("no access to any project")
    expect(signInFailure("can-open-only")).toBe("This account can open some sites, but the dashboard starts at Viewer. Ask an Admin of the project if you need more.")
    expect(signInFailure("something-new")).toContain("didn't go through")
  })
})

describe("access in the Activity", () => {
  const row = (action: string, extra: Partial<AuditRow> = {}): AuditRow => ({
    id: "steward:1.0",
    source: "steward",
    at: "2026-10-07T10:00:00.000Z",
    actor: "owner",
    action,
    target: "cms",
    site: null,
    detail: { result: "ok" },
    ...extra,
  })

  test("today's changes in the spec's words", () => {
    expect(auditWords(row("access.add", { detail: { result: "ok", note: "bob@acme.test: Viewer" } }))).toMatchObject({ summary: "Gave bob@acme.test Viewer on cms", note: null })
    expect(auditWords(row("access.change", { detail: { result: "ok", note: "dana@acme.test: Developer -> Can open" } })).summary).toBe("Changed dana@acme.test from Developer to Can open on cms")
    expect(auditWords(row("access.remove", { detail: { result: "ok", note: "bob@acme.test: was Viewer" } })).summary).toBe("Removed bob@acme.test from cms")
    expect(auditWords(row("access.add", { detail: { result: "rejects", note: "refused" } }))).toMatchObject({ summary: "Tried to give someone access to cms", tone: "attention" })
    expect(auditWords(row("people.create")).summary).toBe("Changed who may create projects")
    expect(auditWords(row("access.general", { detail: { result: "ok", note: "on, ok" } })).summary).toBe("Restricted cms")
    expect(auditWords(row("access.general", { detail: { result: "failure", note: "off, failure" } })).summary).toBe("Tried to make cms public")
  })

  test("rows written before the access registry read in today's words", () => {
    expect(auditWords(row("member.invite", { target: "carol@acme.test", detail: { result: "ok", note: "beta: viewer" } }))).toMatchObject({ summary: "Gave carol@acme.test a role", note: "beta: viewer" })
    expect(auditWords(row("member.signin", { actor: "alice@acme.test" })).summary).toBe("Signed in to the dashboard with a company account")
    expect(auditWords(row("member.signin_failed", { detail: { result: "rejects", note: "not-a-member" } }))).toMatchObject({ note: "no access to any project", tone: "attention" })
    const refused = { actor: "alice@acme.test", target: "alpha", detail: { result: "rejects", note: "role developer" } }
    expect(auditWords(row("member.invite", refused))).toMatchObject({ summary: "Tried to give someone a role", note: "Refused: Developer here", tone: "attention" })
    expect(auditWords(row("sharing.update", refused))).toMatchObject({ summary: "Tried to change who can open it", tone: "attention" })
    expect(auditWords(row("guest.create", refused)).summary).toBe("Tried to give password access")
    expect(auditWords(row("backup.restore", { ...refused, detail: { result: "rejects", note: "no role" } }))).toMatchObject({ note: "Refused: no role on this project" })
  })
})
