import { describe, expect, test } from "bun:test"
import {
  ACCESS_ACTION,
  NO_FILTERS,
  SOURCES,
  accessOnly,
  activityUrl,
  actorLabel,
  auditQuery,
  auditWords,
  countWords,
  csvField,
  detailLines,
  exportName,
  filtersFrom,
  hasFilters,
  isAuditResponse,
  keyWords,
  mergeStatuses,
  refreshRows,
  sourceWords,
  toCsv,
  toJsonLines,
  windowNote,
} from "../src/lib/audit"
import type { AuditResponse, AuditRow, SourceStatus } from "../src/lib/types"

const AT = "2026-10-04T12:00:00.000Z"

function row(partial: Partial<AuditRow> = {}): AuditRow {
  return { id: "portal:1", source: "portal", at: AT, actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", site: "cms", detail: null, ...partial }
}

describe("the sources", () => {
  test("every source the server knows, in its order", () => {
    expect(SOURCES.map((source) => source.key)).toEqual(["dashboard", "portal", "egress", "backups", "steward"])
  })

  test("each state in a word and a tone, red for a source that can't be read alone", () => {
    const status = (partial: Partial<SourceStatus>): SourceStatus => ({ name: "portal", state: "ok", message: null, window: null, ...partial })
    expect(sourceWords(status({}))).toEqual({ word: "Read", tone: "ok" })
    expect(sourceWords(status({ window: 50 }))).toEqual({ word: "Latest 50", tone: "ok" })
    expect(sourceWords(status({ state: "unavailable" }))).toEqual({ word: "Can't read", tone: "error" })
    expect(sourceWords(status({ state: "outdated" }))).toEqual({ word: "Needs updating", tone: "attention" })
    expect(sourceWords(status({ state: "not-installed" }))).toEqual({ word: "Not installed", tone: "neutral" })
  })

  test("the sources read only to their latest entries are named once their end is reached", () => {
    const status = (name: SourceStatus["name"], window: number | null, state: SourceStatus["state"] = "ok"): SourceStatus => ({ name, state, message: null, window })
    expect(windowNote([status("portal", null)])).toBeNull()
    expect(windowNote([status("steward", 50)])).toBe("Steward hands the dashboard its latest 50 entries; older ones stay on the server.")
    expect(windowNote([status("backups", 50), status("steward", 50), status("portal", null)])).toBe("Backups and Steward hand the dashboard their latest 50 entries; older ones stay on the server.")
    expect(windowNote([status("steward", 50, "unavailable")])).toBeNull()
  })

  test("the count on the right of the filters", () => {
    expect(countWords(120, false)).toBe("120 events, newest first")
    expect(countWords(3, true)).toBe("3 matching events, newest first")
    expect(countWords(1, true)).toBe("1 matching event")
    expect(countWords(0, false)).toBe("0 events")
  })

  test("a later page updates the sources it read, the others keep their state", () => {
    const known: SourceStatus[] = [
      { name: "portal", state: "ok", message: null, window: null },
      { name: "steward", state: "unavailable", message: "Can't reach the steward.", window: null },
    ]
    const merged = mergeStatuses(known, [{ name: "portal", state: "unavailable", message: "Can't reach the portal.", window: null }, { name: "dashboard", state: "ok", message: null, window: null }])
    expect(merged.map((status) => [status.name, status.state])).toEqual([
      ["dashboard", "ok"],
      ["portal", "unavailable"],
      ["steward", "unavailable"],
    ])
  })
})

describe("the query", () => {
  test("no filter: the first page, newest first", () => {
    expect(auditQuery(NO_FILTERS)).toBe("?limit=100")
    expect(hasFilters(NO_FILTERS)).toBe(false)
  })

  test("the filters, trimmed, and the cursor of the next page", () => {
    const query = new URLSearchParams(auditQuery({ ...NO_FILTERS, source: "portal", actor: " ada ", action: "portal.", target: "cms" }, "next-page", 50))
    expect(Object.fromEntries(query)).toEqual({ source: "portal", actor: "ada", action: "portal.", target: "cms", limit: "50", cursor: "next-page" })
    expect(hasFilters({ ...NO_FILTERS, target: "cms" })).toBe(true)
    expect(hasFilters({ ...NO_FILTERS, actor: "   " })).toBe(false)
  })

  test("whole days where the person is: `to` includes its own day", () => {
    const query = new URLSearchParams(auditQuery({ ...NO_FILTERS, from: "2026-10-01", to: "2026-10-04" }))
    expect(query.get("from")).toBe(new Date(2026, 9, 1).toISOString())
    expect(query.get("to")).toBe(new Date(2026, 9, 5).toISOString())
    expect(new URLSearchParams(auditQuery({ ...NO_FILTERS, from: "someday" })).has("from")).toBe(false)
  })

  test("an answer is read only in the shape the page expects", () => {
    expect(isAuditResponse({ rows: [], sources: [], cursor: null, scanned: 0 })).toBe(true)
    for (const body of [null, "rows", { rows: {}, sources: [], cursor: null }, { rows: [], sources: [], cursor: 3 }]) expect(isAuditResponse(body)).toBe(false)
  })
})

describe("reading the newest page again", () => {
  const page = (rows: AuditRow[], cursor: string | null = "more"): AuditResponse => ({ rows, sources: [], cursor, scanned: rows.length })

  test("new rows go in front, those already there are not repeated", () => {
    const current = [row({ id: "portal:2" }), row({ id: "portal:1" })]
    const { rows, restart } = refreshRows(current, page([row({ id: "portal:3" }), row({ id: "portal:2" })]))
    expect(restart).toBe(false)
    expect(rows.map((one) => one.id)).toEqual(["portal:3", "portal:2", "portal:1"])
  })

  test("a newest page that no longer reaches the rows shown starts the log over, rather than leave a hole", () => {
    const current = [row({ id: "portal:2" })]
    const { rows, restart } = refreshRows(current, page([row({ id: "portal:9" }), row({ id: "portal:8" })]))
    expect(restart).toBe(true)
    expect(rows.map((one) => one.id)).toEqual(["portal:9", "portal:8"])
    // A newest page that is the whole log reaches everything there is.
    expect(refreshRows(current, page([row({ id: "portal:9" })], null)).restart).toBe(false)
  })
})

describe("a row in words", () => {
  test("the dashboard: tokens and deployments", () => {
    expect(auditWords(row({ source: "dashboard", actor: "owner", action: "token.create", detail: { email: "ada@test-zone.invalid", label: "Ada" } })).summary).toBe("Created a token for ada@test-zone.invalid (Ada)")
    expect(auditWords(row({ source: "dashboard", action: "token.revoke", detail: { email: "ada@test-zone.invalid" } })).summary).toBe("Revoked the token of ada@test-zone.invalid")
    expect(auditWords(row({ source: "dashboard", action: "deploy.start", detail: { creating: true } })).summary).toBe("Started deploying a new project")
    expect(auditWords(row({ source: "dashboard", action: "deploy.success", detail: { creating: false } })).summary).toBe("Deployed")
    expect(auditWords(row({ source: "dashboard", action: "deploy.failure", detail: { error: "install-failed" } }))).toEqual({ summary: "Deployment failed", note: "install-failed", tone: "error" })
  })

  test("the portal: sign-ins, refusals, sign-outs, and the changes of rows written before the access registry, in today's words", () => {
    expect(auditWords(row({ detail: { method: "oidc", role: "developer" } })).summary).toBe("Opened cms as Developer")
    // The portal's role before the registry, "member", says nothing of the ladder: dropped.
    expect(auditWords(row({ detail: { method: "oidc", role: "member" } })).summary).toBe("Opened cms")
    expect(auditWords(row({ detail: { method: "password", count: 4 } }))).toEqual({ summary: "Signed in with the owner's password", note: "4 times", tone: "neutral" })
    expect(auditWords(row({ actor: "eve@elsewhere.test", detail: { method: "password-access" } })).summary).toBe("Opened cms")
    // A guest's sign-in, written before the access registry, reads the same.
    expect(auditWords(row({ detail: { method: "guest" } })).summary).toBe("Opened cms")
    expect(auditWords(row({ detail: { method: "something-new" } })).summary).toBe("Opened cms")
    expect(auditWords(row({ action: "portal.signin_failed", detail: { method: "oidc", reason: "not-shared" } }))).toEqual({ summary: "Sign-in refused", note: "no access to the site", tone: "attention" })
    expect(auditWords(row({ action: "portal.signin_failed", detail: { method: "password" } })).note).toBe("wrong password")
    expect(auditWords(row({ action: "portal.signin_failed", detail: { method: "oidc", reason: "constructor" } })).note).toBe("constructor")
    expect(auditWords(row({ action: "portal.signout" })).summary).toBe("Signed out of cms")
    expect(
      auditWords(row({ actor: "owner", action: "sharing.update", detail: { mode: "people", previousMode: "admins", peopleAdded: ["bob@test-zone.invalid"], peopleRemoved: [], domainsAdded: [], domainsRemoved: [] } })),
    ).toEqual({ summary: "Changed who can open it to specific people", note: "1 person added", tone: "neutral" })
    expect(
      auditWords(row({ action: "sharing.update", detail: { mode: "domain", previousMode: "domain", peopleAdded: [], peopleRemoved: ["a@x.invalid", "b@x.invalid"], domainsAdded: ["test-zone.invalid"], domainsRemoved: [] } })),
    ).toEqual({ summary: "Changed who can open it", note: "2 people removed, 1 domain added", tone: "neutral" })
    expect(auditWords(row({ actor: "owner", action: "guest.create", detail: { guest: "AAAAAAAAAAAAAAA0", label: "Alice", expiresAt: null } })).summary).toBe("Gave password access to Alice")
    expect(auditWords(row({ actor: "owner", action: "guest.revoke", detail: { guest: "AAAAAAAAAAAAAAA0", label: "Alice", expiresAt: null } })).summary).toBe("Removed the password access of Alice")
  })

  test("the egress proxy, in the words of the Connectors page", () => {
    expect(auditWords(row({ source: "egress", actor: "system", action: "egress.denied", target: "shop", detail: { destination: "pastebin.invalid:443", reason: "not in the list", count: 3 } }))).toEqual({
      summary: "Refused pastebin.invalid:443",
      note: "not in the list, 3 times",
      tone: "attention",
    })
    expect(auditWords(row({ source: "egress", action: "connector.grant", actor: "owner", target: "shop", detail: { connector: "chat", granted: true } })).summary).toBe("Granted chat")
  })

  test("the backups: runs and restores", () => {
    expect(auditWords(row({ source: "backups", actor: "system", action: "backup.run", target: null, detail: { ok: true, snapshots: 4, failed: [] } }))).toEqual({ summary: "Scheduled backup", note: "4 snapshots", tone: "neutral" })
    expect(auditWords(row({ source: "backups", action: "backup.run", detail: { ok: false, failed: ["cms", "shop"] } }))).toEqual({ summary: "Scheduled backup failed for 2 sites", note: "cms, shop", tone: "error" })
    expect(auditWords(row({ source: "backups", action: "backup.run", detail: { ok: false, error: "the backup lock is held" } })).tone).toBe("error")
    expect(auditWords(row({ source: "backups", action: "backup.restore", detail: { result: "ok", snapshot: "cms-20261004T120000Z.tar.gz" } })).summary).toBe("Restored cms-20261004T120000Z.tar.gz")
    expect(auditWords(row({ source: "backups", action: "backup.restore", detail: { result: "failure", message: "cms did not start" } }))).toEqual({ summary: "Restore failed", note: "cms did not start", tone: "error" })
  })

  test("the steward: what was done, or tried, and how it ended", () => {
    const steward = (action: string, detail: Record<string, unknown>, target: string | null = "cms") => auditWords(row({ source: "steward", actor: "owner", action, target, detail }))
    expect(steward("secrets.set", { result: "ok", file: "cms.env", variable: "SMTP_PASSWORD" })).toEqual({ summary: "Set SMTP_PASSWORD", note: null, tone: "neutral" })
    expect(steward("secrets.unlock", { result: "ok" }, null)).toEqual({ summary: "Unlocked changes", note: null, tone: "neutral" })
    expect(steward("secrets.unlock", { result: "rejects", note: "wrong password" }, null)).toEqual({ summary: "Tried to unlock changes", note: "Refused: wrong password", tone: "attention" })
    expect(steward("secrets.replace", { result: "ok", file: "builder-secrets/registry" }).summary).toBe("Replaced builder-secrets/registry")
    expect(steward("service.restart", { result: "failure", note: "looping" })).toEqual({ summary: "Tried to restart", note: "Failed: crash loop", tone: "error" })
    expect(steward("access.general", { result: "ok", note: "on, ok" })).toEqual({ summary: "Restricted cms", note: null, tone: "neutral" })
    expect(steward("access.general", { result: "failure", note: "off, failure" })).toEqual({ summary: "Tried to make cms public", note: "Failed", tone: "error" })
  })

  test("the steward's access registry: given, changed, taken away, carried over, and who may create projects", () => {
    const steward = (action: string, detail: Record<string, unknown>, actor = "owner") => auditWords(row({ source: "steward", actor, action, target: "kanban", site: "kanban", detail }))
    expect(steward("access.add", { result: "ok", note: "alice@acme.test: Developer", member: "alice@acme.test" })).toEqual({ summary: "Gave alice@acme.test Developer on kanban", note: null, tone: "neutral" })
    expect(steward("access.add", { result: "ok", note: "dana@acme.test: Can open", member: "dana@acme.test" }).summary).toBe("Let dana@acme.test open kanban")
    expect(steward("access.add", { result: "ok", note: "@acme.test: Can open" }).summary).toBe("Let everyone at acme.test open kanban")
    expect(steward("access.add", { result: "ok", note: "eve@elsewhere.test: Can open, password access until 2026-10-14 10:00 UTC" })).toEqual({
      summary: "Gave eve@elsewhere.test password access to kanban",
      note: "Until 2026-10-14 10:00 UTC",
      tone: "neutral",
    })
    expect(steward("access.add", { result: "rejects", note: "bob@acme.test may give at most Developer on kanban", member: "eve@acme.test" }, "bob@acme.test")).toEqual({
      summary: "Tried to give eve@acme.test access to kanban",
      note: "bob@acme.test may give at most Developer on kanban",
      tone: "attention",
    })
    expect(steward("access.change", { result: "ok", note: "dana@acme.test: Developer -> Can open" })).toEqual({ summary: "Changed dana@acme.test from Developer to Can open on kanban", note: null, tone: "neutral" })
    expect(steward("access.remove", { result: "ok", note: "@acme.test: was Can open" }, "token:aaaaaaaaaaaa")).toEqual({ summary: "Removed @acme.test from kanban", note: "Was Can open", tone: "neutral" })
    expect(steward("access.remove", { result: "ok", note: "bob@acme.test: taken off everywhere, kanban: developer" })).toMatchObject({ summary: "Removed bob@acme.test from every project", note: "Was kanban: developer" })
    expect(steward("access.remove", { result: "rejects", note: "a token removes Can open entries alone" }, "token:aaaaaaaaaaaa")).toMatchObject({ summary: "Tried to remove someone from kanban", tone: "attention" })
    expect(steward("access.migrate", { result: "ok", note: "4 entries, 1 password access" }, "system")).toEqual({
      summary: "Carried who has access over to one registry",
      note: "4 entries, 1 password access",
      tone: "neutral",
    })
    expect(steward("people.create", { result: "ok", note: "carol@acme.test: may create projects" })).toEqual({ summary: "Let carol@acme.test create projects", note: null, tone: "neutral" })
    expect(steward("people.create", { result: "ok", note: "carol@acme.test: may no longer create projects" }).summary).toBe("Took back carol@acme.test's right to create projects")
  })

  test("the dashboard's sign-ins with a company account, and the reason of a refusal", () => {
    const signin = (action: string, detail: Record<string, unknown> = { result: "ok" }) => auditWords(row({ source: "steward", actor: "alice@acme.test", action, target: null, site: null, detail }))
    expect(signin("dashboard.signin", { result: "ok", note: "kanban: Developer" })).toEqual({ summary: "Signed in to the dashboard", note: null, tone: "neutral" })
    expect(signin("dashboard.signout")).toEqual({ summary: "Signed out of the dashboard", note: null, tone: "neutral" })
    expect(signin("dashboard.signin_failed", { result: "rejects", note: "not-a-member" })).toEqual({ summary: "Dashboard sign-in refused", note: "no access to any project", tone: "attention" })
    expect(signin("dashboard.signin_failed", { result: "rejects", note: "no-role" }).note).toBe("no access to any project")
    expect(signin("dashboard.signin_failed", { result: "rejects", note: "can-open-only" }).note).toBe("Can open only: the dashboard starts at Viewer")
    expect(signin("dashboard.signin_failed", { result: "rejects", note: "replayed-assertion" }).note).toBe("sign-in already used")
    // A reason this page does not know is shown as it is, never a prototype's.
    expect(signin("dashboard.signin_failed", { result: "rejects", note: "constructor" }).note).toBe("constructor")
  })

  test("an action this page does not know is shown as it is", () => {
    expect(auditWords(row({ action: "monitor.alert" }))).toEqual({ summary: "monitor.alert", note: null, tone: "neutral" })
  })

  test("who acted, by name: the owner, a token's person, a password access's name, the server", () => {
    expect(actorLabel(row({ actor: "token:abc", detail: { email: "ada@test-zone.invalid" } }))).toBe("ada@test-zone.invalid (token)")
    expect(actorLabel(row({ actor: "token:abc", detail: null }))).toBe("A token")
    expect(actorLabel(row({ actor: "owner", detail: { email: "x@test-zone.invalid" } }))).toBe("Owner")
    expect(actorLabel(row({ actor: "system" }))).toBe("The server")
    expect(actorLabel(row({ actor: "anonymous" }))).toBe("Someone")
    expect(actorLabel(row({ actor: "password:PaSsWoRdAcCeSs07", detail: { method: "password-access", name: "Example Accounting" } }))).toBe("Example Accounting (password access)")
    expect(actorLabel(row({ actor: "guest:benchGuest000001", detail: { method: "guest" } }))).toBe("Someone with password access")
    expect(actorLabel(row({ actor: "eve@elsewhere.test", detail: { method: "password-access" } }))).toBe("eve@elsewhere.test (password access)")
    expect(actorLabel(row({ actor: "alice@acme.test", detail: { method: "oidc" } }))).toBe("alice@acme.test")
  })

  test("an address narrows the log: a site's Access links to its access changes", () => {
    const params = new URLSearchParams("action=access&target=cms&source=steward&ignored=1")
    expect(filtersFrom(params)).toEqual({ ...NO_FILTERS, source: "steward", action: "access", target: "cms" })
    expect(filtersFrom(new URLSearchParams("source=nowhere"))).toEqual(NO_FILTERS)
    expect(activityUrl({ action: "access", target: "cms" })).toBe("/activity/?action=access&target=cms")
    expect(activityUrl({})).toBe("/activity/")
    expect(accessOnly({ ...NO_FILTERS, action: ACCESS_ACTION })).toBe(true)
    expect(accessOnly({ ...NO_FILTERS, action: "access.add" })).toBe(false)
  })
})

describe("a person's own tokens, in words", () => {
  test("the steward's rows: a token created, refused above their roles, revoked, and a project created", () => {
    const steward = (action: string, detail: Record<string, unknown>, actor = "ada@acme.test") => row({ source: "steward", actor, action, target: null, detail })
    expect(auditWords(steward("token.create", { result: "ok", note: "abc: alpha" }))).toMatchObject({ summary: "Created a token of their own", note: "abc: alpha" })
    expect(auditWords(steward("token.create", { result: "rejects", note: "scope.slugs: ..." }))).toMatchObject({ summary: "Tried to create a token above their roles", tone: "attention" })
    expect(auditWords(steward("token.revoke", { result: "ok", note: "abc" }))).toMatchObject({ summary: "Revoked a token of their own" })
    expect(auditWords(steward("token.revoke", { result: "ok", member: "ada@acme.test", note: "abc: gone" }, "owner"))).toMatchObject({ summary: "Revoked the tokens of ada@acme.test" })
    expect(auditWords(steward("project.create", { result: "ok", note: "admin, created with token abc" }))).toMatchObject({ summary: "Created the project with a token, Admin of it" })
  })

  test("a deployment by a person's token names the person as whose it is", () => {
    expect(actorLabel(row({ actor: "token:abc", action: "deploy.start", detail: { email: "ada@acme.test", member: "ada@acme.test" } }))).toBe("ada@acme.test (token)")
  })
})

describe("the detail, as text", () => {
  test("keys in words, nested objects flattened, lists joined, nothing left as an object", () => {
    expect(
      detailLines({ peopleAdded: ["a@test-zone.invalid", "b@test-zone.invalid"], statuses: { "2xx": 3, "5xx": 1 }, valueReplaced: false, error: null, empty: {}, pairs: [{ a: 1 }] }),
    ).toEqual([
      { key: "people added", value: "a@test-zone.invalid, b@test-zone.invalid" },
      { key: "statuses 2xx", value: "3" },
      { key: "statuses 5xx", value: "1" },
      { key: "value replaced", value: "no" },
      { key: "error", value: "none" },
      { key: "empty", value: "none" },
      { key: "pairs", value: '{"a":1}' },
    ])
    expect(detailLines(null)).toEqual([])
    expect(keyWords("previous_mode")).toBe("previous mode")
  })

  test("markup in a detail stays the text it is", () => {
    expect(detailLines({ reason: "<img src=x onerror=alert(1)>" })).toEqual([{ key: "reason", value: "<img src=x onerror=alert(1)>" }])
  })
})

describe("the exports", () => {
  const rows = [
    row({ detail: { method: "oidc", role: "admin" } }),
    row({ id: "portal:2", actor: "=HYPERLINK(\"http://evil.invalid\")", action: "portal.signin_failed", target: null, site: null, detail: null }),
  ]

  test("CSV: a header, one line per row, quoted where needed", () => {
    const lines = toCsv(rows).split("\r\n")
    expect(lines[0]).toBe("at,source,actor,action,target,site,detail")
    expect(lines[1]).toBe(`${AT},portal,ada@test-zone.invalid,portal.signin,cms.test-zone.invalid,cms,"{""method"":""oidc"",""role"":""admin""}"`)
    expect(lines.at(-1)).toBe("")
  })

  test("CSV: a value a spreadsheet would run as a formula stays text", () => {
    expect(toCsv(rows).split("\r\n")[2]).toBe(`${AT},portal,"'=HYPERLINK(""http://evil.invalid"")",portal.signin_failed,,,`)
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) expect(csvField(`${start}1`).replace(/^"/, "").startsWith("'")).toBe(true)
    expect(csvField("plain")).toBe("plain")
    expect(csvField(null)).toBe("")
  })

  test("JSON lines: one object per row, as the server sent it", () => {
    const lines = toJsonLines(rows).split("\n")
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0]!)).toEqual({ at: AT, source: "portal", actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", site: "cms", detail: { method: "oidc", role: "admin" }, id: "portal:1" })
    expect(toJsonLines([])).toBe("")
  })

  test("named after the moment, where the person is", () => {
    expect(exportName("csv", new Date(2026, 9, 4, 9, 5))).toBe("sitesolide-activity-2026-10-04-0905.csv")
    expect(exportName("jsonl", new Date(2026, 0, 31, 23, 59))).toBe("sitesolide-activity-2026-01-31-2359.jsonl")
  })
})
