import { describe, expect, test } from "bun:test"
import {
  PAGE_SIZE,
  SOURCES,
  activityDays,
  activityKeep,
  activityUrl,
  actorLabel,
  auditQuery,
  auditWords,
  clockTime,
  csvField,
  dayHeading,
  dayKey,
  detailLines,
  exportName,
  isAuditResponse,
  isNarrowed,
  readActivity,
  serverKey,
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
    expect(windowNote([status("steward", 50)])).toBe("Access hands the dashboard its latest 50 entries; older ones stay on the server.")
    expect(windowNote([status("backups", 50), status("steward", 50), status("portal", null)])).toBe("Backups and Access hand the dashboard their latest 50 entries; older ones stay on the server.")
    expect(windowNote([status("steward", 50, "unavailable")])).toBeNull()
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
  const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime()

  test("no filter: the first page of fifty, newest first", () => {
    expect(PAGE_SIZE).toBe(50)
    expect(auditQuery({}, NOW)).toBe("?limit=50")
    expect(isNarrowed({})).toBe(false)
  })

  test("the History contract's fields, trimmed, and the cursor of the next page", () => {
    const query = new URLSearchParams(auditQuery({ source: "portal", actor: " ada ", action: "portal.", target: "cms" }, NOW, "next-page"))
    expect(Object.fromEntries(query)).toEqual({ source: "portal", actor: "ada", action: "portal.", target: "cms", limit: "50", cursor: "next-page" })
    expect(isNarrowed({ target: "cms" })).toBe(true)
  })

  test("a type of one prefix goes as the action, a type of several stays the page's", () => {
    expect(new URLSearchParams(auditQuery({ type: "backups" }, NOW)).get("action")).toBe("backup.")
    expect(new URLSearchParams(auditQuery({ type: "access", target: "cms" }, NOW)).has("action")).toBe(false)
  })

  test("a range starts at its since, and a custom range includes its last day", () => {
    expect(new URLSearchParams(auditQuery({ since: "24h" }, NOW)).get("from")).toBe(new Date(NOW - 24 * 3_600_000).toISOString())
    const query = new URLSearchParams(auditQuery({ since: "2026-10-01", until: "2026-10-04" }, NOW))
    expect(query.get("from")).toBe(new Date(2026, 9, 1).toISOString())
    expect(query.get("to")).toBe(new Date(2026, 9, 5).toISOString())
  })

  test("the search reads nothing again: the server is asked the same", () => {
    expect(serverKey({ target: "cms", query: "alice" })).toBe(serverKey({ target: "cms" }))
    expect(serverKey({ target: "cms", type: "access" })).not.toBe(serverKey({ target: "cms" }))
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
    expect(steward("secrets.set", { result: "ok", file: "store", variable: "SMTP_PASSWORD" })).toEqual({ summary: "Set SMTP_PASSWORD", note: null, tone: "neutral" })
    expect(steward("secrets.unlock", { result: "ok" }, null)).toEqual({ summary: "Unlocked changes", note: null, tone: "neutral" })
    expect(steward("secrets.unlock", { result: "rejects", note: "wrong password" }, null)).toEqual({ summary: "Tried to unlock changes", note: "Refused: wrong password", tone: "attention" })
    expect(steward("secrets.replace", { result: "ok", file: "store/gcp.json" }).summary).toBe("Replaced gcp.json")
    // A project's store: a value drawn on the server, never a value. A merge and a retire are rows written
    // before projects kept their secrets in their store alone, still read.
    expect(steward("secrets.generate", { result: "ok", file: "store", variable: "SESSION_SECRET" }).summary).toBe("Generated SESSION_SECRET")
    expect(steward("secrets.migrate", { result: "ok", file: "store", note: "2 merged from a.env, b.env" })).toEqual({
      summary: "Merged the flat files into the store",
      note: "2 merged from a.env, b.env",
      tone: "neutral",
    })
    expect(steward("secrets.retire", { result: "rejects", file: "cms.env", note: "invalid" })).toEqual({ summary: "Tried to retire cms.env", note: "Refused: invalid", tone: "attention" })
    expect(steward("secrets.remove", { result: "ok", file: "store/gcp.json" }).summary).toBe("Removed gcp.json")
    expect(steward("service.restart", { result: "failure", note: "looping" })).toEqual({ summary: "Tried to restart", note: "Failed: crash loop", tone: "error" })
    expect(steward("access.general", { result: "ok", note: "on, ok" })).toEqual({ summary: "Restricted cms", note: null, tone: "neutral" })
    expect(steward("access.general", { result: "failure", note: "off, failure" })).toEqual({ summary: "Tried to make cms public", note: "Failed", tone: "error" })
    expect(steward("access.general", { result: "ok", note: "code, ok" })).toEqual({ summary: "Set cms to Anyone with the code", note: null, tone: "neutral" })
    expect(steward("access.general", { result: "rejects", note: "code, rejects" })).toEqual({ summary: "Tried to set cms to Anyone with the code", note: "Refused", tone: "attention" })
    // A new code, never the code itself: the row says it was given, and to which site.
    expect(steward("access.code", { result: "ok", note: "renew, ok" })).toEqual({ summary: "Gave cms a new code", note: null, tone: "neutral" })
    expect(steward("access.code", { result: "failure", note: "renew, failure" })).toEqual({ summary: "Tried to give cms a new code", note: "Failed", tone: "error" })
  })

  test("the steward's access registry: given, changed, taken away, carried over, and who may create projects", () => {
    const steward = (action: string, detail: Record<string, unknown>, actor = "owner") => auditWords(row({ source: "steward", actor, action, target: "kanban", site: "kanban", detail }), "UTC")
    expect(steward("access.add", { result: "ok", note: "alice@acme.test: Developer", member: "alice@acme.test" })).toEqual({ summary: "Gave alice@acme.test Developer on kanban", note: null, tone: "neutral" })
    expect(steward("access.add", { result: "ok", note: "dana@acme.test: Can open", member: "dana@acme.test" }).summary).toBe("Let dana@acme.test open kanban")
    expect(steward("access.add", { result: "ok", note: "@acme.test: Can open" }).summary).toBe("Let everyone at acme.test open kanban")
    expect(steward("access.add", { result: "ok", note: "eve@elsewhere.test: Can open, password access until 2026-10-14 10:00 UTC" })).toEqual({
      summary: "Gave eve@elsewhere.test password access to kanban",
      note: "Until Oct 14, 10:00 UTC",
      tone: "neutral",
    })
    // Local time with its zone, as the rest of the dashboard says it; what is not a date, as written.
    expect(auditWords(row({ source: "steward", actor: "owner", action: "access.add", target: "kanban", site: "kanban", detail: { result: "ok", note: "eve@elsewhere.test: Can open, password access until 2026-10-14 10:00 UTC" } }), "Europe/Paris").note).toBe("Until Oct 14, 12:00 GMT+2")
    expect(steward("access.add", { result: "ok", note: "eve@elsewhere.test: Can open, password access no expiry" }).note).toBe("No expiry")
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

  test("an address narrows the log: every History link's six fields, the search and a range's end", () => {
    const params = new URLSearchParams("action=access&target=cms&source=steward&type=access&since=7d&ignored=1")
    expect(readActivity(params)).toEqual({ source: "steward", action: "access", target: "cms", type: "access", since: "7d" })
    expect(readActivity(new URLSearchParams("source=nowhere&type=everything"))).toEqual({})
    expect(readActivity(new URLSearchParams("q=%20alice%20&since=2026-10-21&until=2026-10-23"))).toEqual({ query: "alice", since: "2026-10-21", until: "2026-10-23" })
    expect(activityUrl({ action: "access", target: "cms" })).toBe("/activity/?action=access&target=cms")
    expect(activityUrl({})).toBe("/activity/")
  })

  test("a range's end is kept only after a start that is a day, and not before it", () => {
    expect(readActivity(new URLSearchParams("until=2026-10-23")).until).toBeUndefined()
    expect(readActivity(new URLSearchParams("since=7d&until=2026-10-23")).until).toBeUndefined()
    expect(readActivity(new URLSearchParams("since=2026-10-24&until=2026-10-23")).until).toBeUndefined()
    expect(readActivity(new URLSearchParams("since=2026-10-24&until=2026-02-30")).until).toBeUndefined()
  })
})

describe("what the page narrows itself", () => {
  test("a type of several prefixes", () => {
    const keep = activityKeep({ type: "access" })
    expect(keep(row({ action: "access.add", source: "steward" }))).toBe(true)
    expect(keep(row({ action: "sharing.update" }))).toBe(true)
    expect(keep(row({ action: "deploy.success", source: "dashboard" }))).toBe(false)
  })

  test("the search: every word, in the actor, the sentence, the action, the target or the site, accents and case aside", () => {
    const opened = row({ actor: "ada@test-zone.invalid", action: "portal.signin", detail: { role: "viewer" } })
    expect(activityKeep({ query: "ADA cms" })(opened)).toBe(true)
    expect(activityKeep({ query: "opened" })(opened)).toBe(true)
    expect(activityKeep({ query: "portal.sign" })(opened)).toBe(true)
    expect(activityKeep({ query: "Portal" })(opened)).toBe(true)
    expect(activityKeep({ query: "ada photos" })(opened)).toBe(false)
    expect(activityKeep({ query: "  " })(opened)).toBe(true)
  })
})

describe("the days and the runs", () => {
  const TZ = "Europe/Paris"
  const NOW = Date.parse("2026-10-25T12:00:00Z")
  const at = (iso: string, partial: Partial<AuditRow> = {}) => row({ id: `portal:${iso}`, at: iso, ...partial })

  test("a day where the person is, and its heading", () => {
    expect(dayKey(Date.parse("2026-10-24T23:30:00Z"), TZ)).toBe("2026-10-25")
    expect(dayKey(Number.NaN, TZ)).toBe("")
    expect(dayHeading("2026-10-25", NOW, TZ)).toBe("Today")
    expect(dayHeading("2026-10-24", NOW, TZ)).toBe("Yesterday")
    expect(dayHeading("2026-10-23", NOW, TZ)).toBe("Fri, Oct 23")
    expect(dayHeading("2025-12-31", NOW, TZ)).toBe("Wed, Dec 31, 2025")
    expect(dayHeading("", NOW, TZ)).toBe("Date unknown")
  })

  test("yesterday is the calendar's, even across a change of clocks", () => {
    // 26 October 2026 follows the night Paris goes back an hour.
    expect(dayHeading("2026-10-25", Date.parse("2026-10-26T09:00:00Z"), TZ)).toBe("Yesterday")
  })

  test("the time of day under an older day's heading", () => {
    expect(clockTime(Date.parse("2026-10-23T18:05:00Z"), TZ)).toBe("20:05")
    expect(clockTime(Number.NaN, TZ)).toBe("-")
  })

  test("the rows cut into days, newest first, whatever order the sources gave", () => {
    const days = activityDays([at("2026-10-23T10:00:00Z"), at("2026-10-25T09:00:00Z", { actor: "bob@test-zone.invalid" }), at("2026-10-24T10:00:00Z")], NOW, TZ)
    expect(days.map((day) => day.label)).toEqual(["Today", "Yesterday", "Fri, Oct 23"])
  })

  test("the same event repeated within a day folds into one run at its newest", () => {
    const days = activityDays(
      [
        at("2026-10-25T11:00:00Z"),
        at("2026-10-25T10:30:00Z", { actor: "bob@test-zone.invalid" }),
        at("2026-10-25T10:00:00Z"),
        at("2026-10-25T09:00:00Z"),
        at("2026-10-24T09:00:00Z"),
      ],
      NOW,
      TZ,
    )
    const today = days[0]!.items
    expect(today.map((item) => item.rows.length)).toEqual([3, 1])
    expect(today[0]!.key).toBe("run:portal:2026-10-25T11:00:00Z")
    expect(today[0]!.rows.map((one) => one.at)).toEqual(["2026-10-25T11:00:00Z", "2026-10-25T10:00:00Z", "2026-10-25T09:00:00Z"])
    // Another day starts its own.
    expect(days[1]!.items.map((item) => item.rows.length)).toEqual([1])
  })

  test("a failure never hides in a run of successes, nor one variable in another's", () => {
    const run = (detail: Record<string, unknown>) => row({ id: `backups:${JSON.stringify(detail)}`, source: "backups", actor: "system", action: "backup.run", target: null, site: null, at: "2026-10-25T10:00:00Z", detail })
    const days = activityDays([run({ snapshots: 9 }), run({ snapshots: 9, failed: ["cms"] }), run({ snapshots: 8 })], NOW, TZ)
    expect(days[0]!.items.map((item) => [item.words.summary, item.rows.length])).toEqual([
      ["Scheduled backup", 2],
      ["Scheduled backup failed for 1 site", 1],
    ])
    const set = (variable: string) => row({ id: `steward:${variable}`, source: "steward", actor: "owner", action: "secrets.set", target: "cms", detail: { variable, result: "ok" } })
    expect(activityDays([set("A"), set("B")], NOW, TZ)[0]!.items).toHaveLength(2)
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

describe("what a token did through the steward, in words", () => {
  // As the dashboard normalizes the steward's journal (src/audit/normalize.ts, `fromJournal`):
  // the token as actor, its person, when it is someone's, in the detail.
  const byToken = (action: string, detail: Record<string, unknown>, member: string | null = "alice@example.com") =>
    row({ id: "steward:1.0", source: "steward", actor: "token:a11ce0c1ab12", action, target: "cms", site: "cms", detail: member === null ? detail : { ...detail, member } })

  test("a secret set, removed, the store created, a restart: the same words as the owner's own", () => {
    expect(auditWords(byToken("secrets.set", { result: "ok", file: "store", variable: "API_KEY" }))).toEqual({ summary: "Set API_KEY", note: null, tone: "neutral" })
    expect(auditWords(byToken("secrets.remove", { result: "ok", file: "store", variable: "OLD_KEY" })).summary).toBe("Removed OLD_KEY")
    expect(auditWords(byToken("secrets.create", { result: "ok", file: "store" })).summary).toBe("Created store")
    expect(auditWords(byToken("service.restart", { result: "ok", note: "active, active/running, 0 restarts" })).summary).toBe("Restarted")
    expect(auditWords(byToken("service.restart", { result: "failure", note: "looping" }))).toEqual({ summary: "Tried to restart", note: "Failed: crash loop", tone: "error" })
  })

  test("a refusal says what was tried and why, never a name the steward did not accept", () => {
    expect(auditWords(byToken("secrets.set", { result: "rejects", file: "store", note: "no secrets permission" }))).toEqual({
      summary: "Tried to set",
      note: "Refused: no secrets permission",
      tone: "attention",
    })
    expect(auditWords(byToken("secrets.read", { result: "rejects", note: "role viewer" })).summary).toBe("Tried to read")
  })

  test("a listing refused reads as a listing, never as a value read", () => {
    expect(auditWords(byToken("secrets.list", { result: "rejects", note: "no secrets permission" }))).toEqual({
      summary: "Tried to list the secrets",
      note: "Refused: no secrets permission",
      tone: "attention",
    })
    expect(auditWords(byToken("secrets.list", { result: "rejects", note: "role viewer" })).summary).not.toContain("read")
  })

  test("by a person's token, the person; by the owner's own, a token", () => {
    expect(actorLabel(byToken("secrets.set", { result: "ok", variable: "API_KEY" }))).toBe("alice@example.com (token)")
    expect(actorLabel(byToken("secrets.set", { result: "ok", variable: "API_KEY" }, null))).toBe("A token")
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
