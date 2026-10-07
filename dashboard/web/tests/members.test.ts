import { describe, expect, test } from "bun:test"
import {
  invitationLine,
  isMember,
  isProjectAdmin,
  mayRestart,
  reauthUrl,
  roleOn,
  unlockFailure,
  memberRefusal,
  rolesFromRows,
  rolesSummary,
  rowsFromRoles,
  signInFailure,
  signInUrl,
  validateMemberForm,
} from "../src/lib/members"
import { MACHINE_PAGES, SECTIONS, machinePagesFor, mayOpen, pageFromUrl, sectionsFor } from "../src/lib/pages"
import { auditWords } from "../src/lib/audit"
import type { AuditRow, IdentityView } from "../src/lib/types"

const OWNER: IdentityView = { kind: "owner" }
const ALICE: IdentityView = { kind: "member", email: "alice@acme.test", name: null, roles: { blog: "developer", shop: "viewer", cms: "admin" }, create: false, expiresAt: 0 }
/** A viewer everywhere, without the create right: nothing to mint. */
const VIC: IdentityView = { kind: "member", email: "vic@acme.test", name: null, roles: { shop: "viewer" }, create: false, expiresAt: 0 }

describe("what a member sees of the page", () => {
  test("Sites, Activity, Team when they may mint a token, and in a site the sections their role there opens; the owner, every section but a project's Members", () => {
    expect(machinePagesFor(ALICE).map((entry) => entry.name)).toEqual(["home", "activity", "team"])
    expect(machinePagesFor(VIC).map((entry) => entry.name)).toEqual(["home", "activity"])
    expect(machinePagesFor({ ...VIC, create: true } as IdentityView).map((entry) => entry.name)).toEqual(["home", "activity", "team"])
    expect(sectionsFor(ALICE, "shop").map((entry) => entry.section)).toEqual(["overview", "audience"])
    expect(sectionsFor(ALICE, "blog").map((entry) => entry.section)).toEqual(["overview", "audience", "secrets"])
    expect(sectionsFor(ALICE, "cms").map((entry) => entry.section)).toEqual(["overview", "audience", "secrets", "guests", "sharing", "access", "backups", "members"])
    expect(machinePagesFor(OWNER)).toEqual(MACHINE_PAGES)
    expect(sectionsFor(null, "blog")).toEqual(SECTIONS.filter((entry) => entry.section !== "members"))
  })

  test("a page that is not theirs, reached by its address, says so", () => {
    for (const path of ["/members/", "/connectors/"]) expect(mayOpen(pageFromUrl(path), ALICE)).toBe(false)
    // Their own tokens: a Developer or a Project admin somewhere, or the create right; never a viewer everywhere.
    expect(mayOpen(pageFromUrl("/team/"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/team/"), VIC)).toBe(false)
    expect(mayOpen(pageFromUrl("/site/secrets/", "?s=shop"), ALICE)).toBe(false)
    expect(mayOpen(pageFromUrl("/site/secrets/", "?s=blog"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/site/access/", "?s=blog"), ALICE)).toBe(false)
    expect(mayOpen(pageFromUrl("/site/members/", "?s=cms"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/site/audience/", "?s=blog"), ALICE)).toBe(true)
    expect(mayOpen(pageFromUrl("/members/"), OWNER)).toBe(true)
    expect(mayOpen(pageFromUrl("/site/members/", "?s=cms"), OWNER)).toBe(false)
    expect(pageFromUrl("/members/")).toEqual({ name: "members" })
  })

  test("the restart is offered to a developer and a project admin, on their own projects", () => {
    expect(mayRestart(ALICE, "blog")).toBe(true)
    expect(mayRestart(ALICE, "shop")).toBe(false)
    expect(mayRestart(ALICE, "notes")).toBe(false)
    expect(mayRestart(OWNER, "blog")).toBe(false)
    expect(isMember(ALICE) && !isMember(OWNER) && !isMember(null)).toBe(true)
  })
})

describe("a member's unlock", () => {
  test("leaves for a forced sign-in and comes back to the page, a previous refusal's note left off", () => {
    expect(reauthUrl("/site/secrets/", "?s=blog&unlock=refused")).toBe("/api/sso/begin?reauth=1&return=%2Fsite%2Fsecrets%2F%3Fs%3Dblog")
    expect(reauthUrl("/site/access/", "")).toBe("/api/sso/begin?reauth=1&return=%2Fsite%2Faccess%2F")
  })

  test("an unlock that came back without unlocking says why in words", () => {
    expect(unlockFailure(null)).toBeNull()
    expect(unlockFailure("refused")).toContain("didn't confirm")
    expect(unlockFailure("another-account")).toContain("another account")
    expect(unlockFailure("nothing-to-unlock")).toContain("viewer on every project")
    expect(unlockFailure("whatever")).toContain("isn't available")
  })

  test("the role on a project, and who is its Project admin", () => {
    expect(roleOn(ALICE, "blog")).toBe("developer")
    expect(roleOn(ALICE, "nowhere")).toBeNull()
    expect(roleOn(OWNER, "blog")).toBeNull()
    expect(isProjectAdmin(ALICE, "cms")).toBe(true)
    expect(isProjectAdmin(ALICE, "blog")).toBe(false)
  })
})

describe("the Members page", () => {
  test("the line to send names the dashboard and the provider", () => {
    expect(invitationLine("https://dashboard.test-zone.invalid", "Google")).toBe("Open https://dashboard.test-zone.invalid and sign in with your Google work account.")
    expect(invitationLine("https://dashboard.test-zone.invalid", null)).toBe("Open https://dashboard.test-zone.invalid and sign in with your work account.")
  })

  test("the form refuses what it can see before sending", () => {
    expect(validateMemberForm("alice@acme.test", [{ slug: "blog", role: "viewer" }], ["acme.test"])).toEqual({})
    expect(validateMemberForm("alice", [{ slug: "blog", role: "viewer" }], [])).toMatchObject({ email: expect.any(String) })
    expect(validateMemberForm("eve@elsewhere.test", [{ slug: "blog", role: "viewer" }], ["acme.test"])).toMatchObject({ email: expect.stringContaining("acme.test") })
    expect(validateMemberForm("alice@acme.test", [], [])).toMatchObject({ roles: "Give them a role on one project at least, or the right to create projects." })
    // The right to create projects alone: someone who will create their own projects, none yet.
    expect(validateMemberForm("alice@acme.test", [], [], true)).toEqual({})
    expect(validateMemberForm("alice@acme.test", [{ slug: "", role: "viewer" }], [], true)).toEqual({})
    expect(validateMemberForm("alice@acme.test", [{ slug: "blog", role: "viewer" }, { slug: "blog", role: "admin" }], [])).toMatchObject({ roles: "A project appears twice." })
  })

  test("rows and roles, both ways, in words", () => {
    const roles = rolesFromRows([{ slug: "shop", role: "viewer" }, { slug: "blog", role: "developer" }])
    expect(roles).toEqual({ shop: "viewer", blog: "developer" })
    expect(rowsFromRoles(roles)).toEqual([{ slug: "blog", role: "developer" }, { slug: "shop", role: "viewer" }])
    expect(rolesSummary(roles)).toBe("blog: Developer, shop: Viewer")
    expect(rolesSummary({ blog: "admin" })).toBe("blog: Project admin")
  })

  test("a refusal goes under the field it concerns", () => {
    expect(memberRefusal(400, { error: "invalid", message: "eve@elsewhere.test cannot sign in here: the portal admits only acme.test (OIDC_ALLOWED_DOMAINS)" }).field).toBe("email")
    expect(memberRefusal(400, { error: "invalid", message: "roles: gone is not deployed on this machine" }).field).toBe("roles")
    expect(memberRefusal(502, { error: "failure", message: "Can't reach the steward." })).toEqual({ field: null, message: "Can't reach the steward." })
  })
})

describe("the sign-in with a work account", () => {
  test("starts at the dashboard, and says why it came back without a session", () => {
    expect(signInUrl("/site/?s=blog")).toBe("/api/sso/begin?return=%2Fsite%2F%3Fs%3Dblog")
    expect(signInUrl("/", true)).toBe("/api/sso/begin?return=%2F&account=choose")
    expect(signInFailure(null)).toBeNull()
    expect(signInFailure("not-a-member")).toContain("isn't a member")
    expect(signInFailure("something-new")).toContain("didn't go through")
  })
})

describe("a member's events in the Activity", () => {
  const row = (action: string, extra: Partial<AuditRow> = {}): AuditRow => ({
    id: "steward:1.0",
    source: "steward",
    at: "2026-10-07T10:00:00.000Z",
    actor: "owner",
    action,
    target: "alice@acme.test",
    site: null,
    detail: { result: "ok" },
    ...extra,
  })

  test("each one in words, the reason of a refusal included", () => {
    expect(auditWords(row("member.invite", { detail: { result: "ok", note: "blog: developer" } }))).toMatchObject({ summary: "Invited alice@acme.test", note: "blog: developer" })
    expect(auditWords(row("member.signin", { actor: "alice@acme.test" })).summary).toBe("Signed in to the dashboard with a work account")
    expect(auditWords(row("member.signin_failed", { detail: { result: "rejects", note: "not-a-member" } }))).toMatchObject({ note: "not a member", tone: "attention" })
    expect(auditWords(row("service.restart", { actor: "alice@acme.test", target: "blog", detail: { result: "ok", note: "active, active/running, 0 restarts" } })).summary).toBe("Restarted")
  })

  test("a Project admin's change names the member, and a refusal by role says the role", () => {
    const byAdmin = { actor: "bob@acme.test", target: "beta", detail: { result: "ok", note: "beta: viewer", member: "carol@acme.test" } }
    expect(auditWords(row("member.invite", byAdmin))).toMatchObject({ summary: "Invited carol@acme.test", note: "beta: viewer" })
    const refused = { actor: "alice@acme.test", target: "alpha", detail: { result: "rejects", note: "role developer" } }
    expect(auditWords(row("member.invite", refused))).toMatchObject({ summary: "Tried to invite someone", note: "Refused: developer here", tone: "attention" })
    expect(auditWords(row("sharing.update", refused))).toMatchObject({ summary: "Tried to change who gets in", tone: "attention" })
    expect(auditWords(row("secrets.read", refused))).toMatchObject({ summary: "Tried to read" })
    expect(auditWords(row("backup.restore", { ...refused, detail: { result: "rejects", note: "no role" } }))).toMatchObject({ note: "Refused: no role on this project" })
  })
})
