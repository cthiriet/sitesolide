import { describe, expect, test } from "bun:test"
import { settingState } from "../src/lib/machine-settings"
import {
  DELIVERED_SITES_MS,
  GUIDE_STEPS,
  NO_PREFS,
  OFFSITE_FIELDS,
  SERVER_GROUPS,
  SETUP_KEY,
  SIGNIN_FIELDS,
  VALUE_STEP,
  changeDates,
  changedWords,
  drawPassphrase,
  fileCommand,
  formatSummary,
  formatWrite,
  httpsProblem,
  initialFormatChoice,
  missingFile,
  nextPassSeconds,
  nextStep,
  UNLOCK_MARGIN_MS,
  offsiteDetailsReady,
  offsiteWrites,
  openingStep,
  otherFormat,
  partialSave,
  unlockFirst,
  passphraseHint,
  passphraseReady,
  pingCheck,
  previousStep,
  proofPhase,
  readSetupPrefs,
  removalOf,
  revealedOf,
  rowSpec,
  serverRow,
  serverSignal,
  signinReady,
  sitesRowIds,
  sitesRows,
  stepPosition,
  storeSetupPrefs,
  waitingWords,
  wantedFormat,
  webhookCheck,
  withSkipped,
  writesOf,
  type Proof,
  type RowInputs,
  type SitesInputs,
} from "../src/lib/server-setup"
import { machineIndicators } from "../src/lib/sidebar"
import type { Alerting, FileView, LogEntry, ProjectView } from "../src/lib/types"
import { discrepancy, secretFile, secretProject } from "./factory"

const NOW = 1_800_000_000_000
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

const MONITOR_FILE = "dashboard-monitor.env"
const BACKUP_FILE = "dashboard-backup.env"
const OFFSITE_FIVE = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_ENCRYPTION_PASSPHRASE"]
const SIGNIN_THREE = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]

// By code point, as tests/redaction.test.ts does: this file must not hold what it forbids.
const DASHES = [String.fromCodePoint(0x2014), String.fromCodePoint(0x2013)]

/** The two platform sites as the steward lists them, every file there unless the test says otherwise. */
function server({
  dashboard = {},
  monitor = ["HEARTBEAT_URL", "ALERT_WEBHOOK_URL"],
  backup = [],
  portal = [],
  files = {},
}: {
  dashboard?: Partial<FileView>
  monitor?: string[] | null
  backup?: string[] | null
  portal?: string[]
  files?: Partial<Record<string, Partial<FileView>>>
} = {}): ProjectView[] {
  const flat = (name: string, variables: string[], more: Partial<FileView> = {}) =>
    secretFile({ name, variables, passwords: variables.filter((one) => one === "PASSWORD_HASH"), expected: "root:root 0600", modifiedAt: NOW - 3 * DAY, ...more, ...files[name] })
  return [
    secretProject({
      slug: "dashboard",
      files: [
        flat("dashboard.env", ["PASSWORD_HASH"], { modifiedAt: NOW - 12 * DAY, ...dashboard }),
        ...(monitor === null ? [] : [flat(MONITOR_FILE, monitor, { modifiedAt: NOW - 35 * MINUTE })]),
        ...(backup === null ? [] : [flat(BACKUP_FILE, backup)]),
      ],
    }),
    secretProject({ slug: "portal", files: [flat("portal.env", ["PASSWORD_HASH", ...portal], { modifiedAt: NOW - 40 * DAY })] }),
  ]
}

const alerting = (partial: Partial<Alerting> = {}): Alerting => ({ heartbeat: "ok", webhook: "ok", undelivered: 0, at: NOW - 20 * SECOND, ...partial })

function inputs(projects: ProjectView[], more: Partial<RowInputs> & { log?: LogEntry[] | null; issues?: ReturnType<typeof discrepancy>[] } = {}): RowInputs {
  const found = "alerting" in more ? more.alerting! : alerting()
  const states = settingState(projects, more.issues ?? [], found)
  return {
    states,
    alerting: found,
    serverNow: NOW,
    changed: changeDates(states, more.log ?? null),
    proof: null,
    offsite: null,
    skipped: new Set(),
    ...more,
  }
}

const sites = (base: RowInputs, more: Partial<SitesInputs> = {}): SitesInputs => ({ ...base, hidden: false, guideOpen: null, ...more })

const entry = (partial: Partial<LogEntry>): LogEntry => ({
  a: NOW - MINUTE,
  operation: "set",
  result: "ok",
  actor: "owner",
  member: null,
  slug: "dashboard",
  file: MONITOR_FILE,
  variable: "HEARTBEAT_URL",
  detail: null,
  ...partial,
})

describe("the Server page", () => {
  test("three panels, every setting in the same order, each with when a change applies", () => {
    expect(SERVER_GROUPS.map((group) => group.title)).toEqual(["Alerts", "Sign-in", "Backups"])
    expect(SERVER_GROUPS.map((group) => group.rows)).toEqual([["heartbeat", "webhook"], ["dashboard-password", "portal-password", "company-signin"], ["offsite"]])
    expect(SERVER_GROUPS.map((group) => group.note)).toEqual([
      "Changes apply within a minute. Nothing restarts.",
      "The portal applies changes when it restarts.",
      "The next hourly backup uses the change.",
    ])
  })

  test("every row shows, set or not: nothing set reads Not set or Off, and only the heartbeat and the webhook ask for a look", () => {
    const row = inputs(server({ monitor: [] }), { alerting: alerting({ heartbeat: "unconfigured", webhook: "unconfigured" }) })
    expect(serverRow("heartbeat", row)).toMatchObject({ word: "Not set", tone: "attention", action: { kind: "guide", label: "Set up", start: "start" }, menu: [] })
    expect(serverRow("webhook", row)).toMatchObject({ word: "Not set", tone: "attention" })
    expect(serverRow("offsite", row)).toMatchObject({ word: "Off", tone: "neutral", menu: ["skip"] })
    expect(serverRow("company-signin", row)).toMatchObject({ word: "Not set", tone: "neutral", menu: ["skip"] })
  })

  test("a file the owner has not made yet reads as not set: its guide says how to make it", () => {
    const row = inputs(server({ monitor: null, backup: null }), { alerting: null })
    expect(serverRow("heartbeat", row)).toMatchObject({ word: "Not set", action: { label: "Set up", start: "start" } })
    expect(serverRow("offsite", row)).toMatchObject({ word: "Off", action: { label: "Set up" } })
  })

  test("a setting set says when it changed, from the steward's log when it shares its file", () => {
    const log = [entry({ a: NOW - 4 * MINUTE }), entry({ a: NOW - 2 * DAY, variable: "ALERT_WEBHOOK_URL" }), entry({ a: NOW - MINUTE, variable: "HEARTBEAT_URL", result: "rejects" })]
    const row = inputs(server(), { log })
    expect(serverRow("heartbeat", row)).toMatchObject({ word: "Set, changed 4 minutes ago", tone: "neutral", action: { label: "Change", start: "value" }, menu: ["reveal", "remove"] })
    expect(serverRow("webhook", row).word).toBe("Set, changed 2 days ago")
    // Alone in its file, the file's date is the setting's.
    expect(serverRow("dashboard-password", row)).toMatchObject({ word: "Set, changed 12 days ago", action: { kind: "password" }, menu: [] })
  })

  test("with no line of the log about it, a setting sharing its file says Set, and no date", () => {
    expect(serverRow("heartbeat", inputs(server(), { log: [] })).word).toBe("Set")
    expect(serverRow("portal-password", inputs(server({ portal: SIGNIN_THREE }), { log: [] })).word).toBe("Set")
  })

  test("a restore of the whole file dates every setting in it", () => {
    const row = inputs(server(), { log: [entry({ operation: "restore", variable: null, a: NOW - 3 * MINUTE })] })
    expect(serverRow("heartbeat", row).word).toBe("Set, changed 3 minutes ago")
    expect(serverRow("webhook", row).word).toBe("Set, changed 3 minutes ago")
  })

  test("a heartbeat the monitor fails to ping: red, the severity in the gutter, and its one primary action opens the value", () => {
    const row = inputs(server(), { alerting: alerting({ heartbeat: "failed" }) })
    expect(serverRow("heartbeat", row)).toMatchObject({
      word: "Failed",
      tone: "error",
      error: true,
      extra: "last ping did not go through",
      action: { kind: "guide", label: "Change the URL", start: "value", primary: true },
    })
  })

  test("a webhook that fails says how many alerts wait", () => {
    const row = inputs(server(), { alerting: alerting({ webhook: "failed", undelivered: 3 }) })
    expect(serverRow("webhook", row)).toMatchObject({ word: "Failed", tone: "error", extra: "3 undelivered", action: { label: "Change", primary: true } })
    expect(serverRow("webhook", row).tip).toContain("3 messages")
  })

  test("the offsite copy: incomplete opens at its details, on with where it goes, misconfigured when the last run could not use it", () => {
    expect(serverRow("offsite", inputs(server({ backup: OFFSITE_FIVE.slice(0, 3) })))).toMatchObject({
      word: "Incomplete",
      tone: "attention",
      extra: "3 of 5 needed settings are set",
      action: { label: "Set up", start: "value" },
      menu: ["reveal", "remove"],
    })
    const set = inputs(server({ backup: OFFSITE_FIVE }))
    expect(serverRow("offsite", { ...set, offsite: { target: "example-backups at s3.example.test", error: null } })).toMatchObject({ word: "On", tone: "ok", extra: "example-backups at s3.example.test" })
    expect(serverRow("offsite", { ...set, offsite: { target: null, error: "the bucket answered 403" } })).toMatchObject({ word: "Misconfigured", tone: "attention" })
    // The backups not read yet, or before a run: the date alone.
    expect(serverRow("offsite", set).word).toBe("Set, changed 3 days ago")
  })

  test("a file the steward does not rewrite: the row says so and leads to the reason, never to a guide", () => {
    const row = inputs(server({ backup: [], files: { [BACKUP_FILE]: { state: "unmanaged", reason: "a reason" } } }))
    expect(serverRow("offsite", row)).toMatchObject({ word: "Unmanaged", tone: "attention", action: { kind: "secrets", label: "See why", slug: "dashboard" }, menu: [] })
  })

  test("a password changed since its reader started: Restart pending, and the restart in the menu", () => {
    const row = inputs(server({ dashboard: { restartPending: true, modifiedAt: NOW - 4 * MINUTE } }))
    expect(serverRow("dashboard-password", row)).toMatchObject({ word: "Restart pending", tone: "attention", extra: "changed 4 minutes ago", menu: ["restart"], action: { kind: "password" } })
    expect(serverRow("dashboard-password", row).tip).toBe("Sign-in uses the new password after the dashboard restarts.")
  })

  test("company sign-in waiting for the portal's restart carries the restart before Remove", () => {
    const row = inputs(server({ portal: SIGNIN_THREE, files: { "portal.env": { restartPending: true } } }), { log: [entry({ slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", a: NOW - 4 * MINUTE })] })
    expect(serverRow("company-signin", row)).toMatchObject({ word: "Restart pending", extra: "changed 4 minutes ago", menu: ["reveal", "restart", "remove"] })
    expect(serverRow("portal-password", row)).toMatchObject({ word: "Restart pending", menu: ["restart"] })
  })

  test("a skipped setting says so on the Server page, and offers Unskip", () => {
    const row = inputs(server(), { skipped: new Set(["offsite"]) })
    expect(serverRow("offsite", row)).toMatchObject({ word: "Off", extra: "skipped", menu: ["unskip"] })
  })

  test("nothing is said before the steward's listing", () => {
    const row = inputs([], { alerting: null })
    for (const group of SERVER_GROUPS) for (const id of group.rows) expect(serverRow(id, row)).toMatchObject({ word: "", action: null })
  })
})

describe("the heartbeat's first ping", () => {
  const proof = (partial: Partial<Proof> = {}): Proof => ({ savedAt: NOW - 30 * SECOND, deliveredAt: null, seen: false, ...partial })

  test("its phase follows the monitor's first pass after the save", () => {
    expect(proofPhase(proof(), alerting({ at: NOW - 40 * SECOND }))).toBe("waiting")
    expect(proofPhase(proof(), alerting({ at: NOW - 5 * SECOND }))).toBe("delivered")
    expect(proofPhase(proof(), alerting({ at: NOW - 5 * SECOND, heartbeat: "failed" }))).toBe("failed")
    // A pass that read the address and took none: the monitor refused it.
    expect(proofPhase(proof(), alerting({ at: NOW - 5 * SECOND, heartbeat: "unconfigured" }))).toBe("refused")
    expect(proofPhase(proof(), null)).toBe("unknown")
  })

  test("the wait counts down to the next pass, then says it is due", () => {
    expect(nextPassSeconds(alerting({ at: NOW - 26 * SECOND }), NOW)).toBe(34)
    expect(nextPassSeconds(alerting({ at: NOW - 90 * SECOND }), NOW)).toBe(0)
    expect(waitingWords(alerting({ at: NOW - 26 * SECOND }), NOW)).toBe("Waiting for the monitor's next pass… 34s")
    expect(waitingWords(alerting({ at: NOW - 90 * SECOND }), NOW)).toBe("Waiting for the monitor's next pass, any moment now.")
  })

  test("on the Server page: progress while it is awaited, Delivered once it came, Failed when it did not", () => {
    const base = inputs(server(), { alerting: alerting({ at: NOW - 40 * SECOND }) })
    expect(serverRow("heartbeat", { ...base, proof: proof() })).toMatchObject({ word: "Set, changed 30 seconds ago", extra: "first ping in 20s", action: { label: "See progress", start: "wait" } })
    const after = inputs(server(), { alerting: alerting({ at: NOW - 5 * SECOND }) })
    expect(serverRow("heartbeat", { ...after, proof: proof() })).toMatchObject({ word: "Delivered", tone: "ok", check: true })
    expect(serverRow("heartbeat", { ...after, proof: proof({ deliveredAt: NOW - 2 * MINUTE }) })).toMatchObject({ word: "Set", check: false })
    const refused = inputs(server(), { alerting: alerting({ at: NOW - 5 * SECOND, heartbeat: "unconfigured" }) })
    expect(serverRow("heartbeat", { ...refused, proof: proof() })).toMatchObject({ word: "Failed", extra: "the monitor didn't take the address" })
  })
})

describe("the setup guide on Sites", () => {
  test("only what is missing, in the guide's order, the optional ones skippable", () => {
    const base = inputs(server({ monitor: ["ALERT_WEBHOOK_URL"] }), { alerting: alerting({ heartbeat: "unconfigured" }) })
    expect(sitesRowIds(sites(base))).toEqual(["heartbeat", "offsite", "company-signin"])
    const rows = sitesRows(sites(base))
    expect(rows.map((row) => [row.id, row.line, row.menu])).toEqual([
      ["heartbeat", "Nothing outside the server notices if it goes down.", []],
      ["offsite", "Snapshots stay on this server only.", ["skip"]],
      ["company-signin", "Optional. People sign in with their company account.", ["skip"]],
    ])
  })

  test("the first row left to do carries the panel's one primary button", () => {
    const base = inputs(server({ monitor: [] }), { alerting: alerting({ heartbeat: "unconfigured", webhook: "unconfigured" }) })
    const primaries = sitesRows(sites(base)).map((row) => row.action?.kind === "guide" && row.action.primary)
    expect(primaries).toEqual([true, false, false, false])
  })

  test("everything set or skipped: nothing left, and the panel goes", () => {
    const done = inputs(server({ backup: OFFSITE_FIVE, portal: SIGNIN_THREE }))
    expect(sitesRowIds(sites(done))).toEqual([])
    const skipped = inputs(server(), { skipped: new Set(["offsite", "company-signin"]) })
    expect(sitesRowIds(sites(skipped))).toEqual([])
  })

  test("hidden by the viewer, or before the listing, the guide shows nothing", () => {
    const base = inputs(server({ monitor: [] }))
    expect(sitesRowIds(sites(base, { hidden: true }))).toEqual([])
    expect(sitesRowIds(sites(inputs([], { alerting: null })))).toEqual([])
  })

  test("a file the steward does not rewrite is not for the guide", () => {
    const base = inputs(server({ files: { [BACKUP_FILE]: { state: "unmanaged", reason: "a reason" } } }), { skipped: new Set(["company-signin"]) })
    expect(sitesRowIds(sites(base))).toEqual([])
  })

  test("an incomplete setting says how much is there", () => {
    const base = inputs(server({ backup: OFFSITE_FIVE.slice(0, 2) }), { skipped: new Set(["company-signin"]) })
    expect(sitesRows(sites(base))[0]).toMatchObject({ id: "offsite", line: "Incomplete: 2 of 5 needed settings are set.", action: { label: "Set up", start: "start" } })
  })

  test("the row of the guide open stays, saved, until the guide closes", () => {
    const base = inputs(server({ portal: SIGNIN_THREE }), { skipped: new Set(["offsite"]), log: [entry({ slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", a: NOW - 5 * SECOND })] })
    expect(sitesRowIds(sites(base))).toEqual([])
    expect(sitesRows(sites(base, { guideOpen: "company-signin" }))).toMatchObject([
      { id: "company-signin", word: "Set, changed just now", line: "The portal reads these when it starts: restart it to apply.", action: null },
    ])
  })

  test("the heartbeat stays while its first ping is awaited, and goes a moment after it came", () => {
    const proof: Proof = { savedAt: NOW - 30 * SECOND, deliveredAt: null, seen: false }
    const waiting = inputs(server({ backup: OFFSITE_FIVE, portal: SIGNIN_THREE }), { alerting: alerting({ at: NOW - 40 * SECOND, heartbeat: "unconfigured" }), proof })
    expect(sitesRows(sites(waiting))).toMatchObject([{ id: "heartbeat", word: "Set, changed 30 seconds ago", line: "Waiting for the monitor's next pass… 20s", action: { label: "See progress", start: "wait" } }])
    const came = { ...waiting, alerting: alerting({ at: NOW - 5 * SECOND }) }
    expect(sitesRows(sites(came))).toMatchObject([{ id: "heartbeat", word: "Delivered", tone: "ok", line: "The monitor's ping went through." }])
    expect(sitesRowIds(sites({ ...came, proof: { ...proof, deliveredAt: NOW - DELIVERED_SITES_MS - SECOND } }))).toEqual([])
    expect(sitesRowIds(sites({ ...came, proof: { ...proof, seen: true } }))).toEqual([])
    // Seen in its guide, which is still open: it stays until the guide closes.
    expect(sitesRowIds(sites({ ...came, proof: { ...proof, deliveredAt: NOW - MINUTE } }, { guideOpen: "heartbeat" }))).toEqual(["heartbeat"])
  })

  test("a heartbeat the monitor fails to ping comes back to the guide, its fix the primary action", () => {
    const base = inputs(server({ backup: OFFSITE_FIVE, portal: SIGNIN_THREE }), { alerting: alerting({ heartbeat: "failed" }) })
    expect(sitesRows(sites(base))).toMatchObject([
      { id: "heartbeat", word: "Failed", tone: "error", error: true, line: "The monitor couldn't reach it. Check the URL.", action: { label: "Change the URL", start: "value", primary: true } },
    ])
  })
})

describe("the viewer's own choices", () => {
  /** A storage in memory that says what it was given, and can refuse. */
  function memory(initial: Record<string, string> = {}, refuse = false) {
    const items = new Map(Object.entries(initial))
    const storage = {
      getItem: (key: string) => {
        if (refuse) throw new Error("denied")
        return items.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (refuse) throw new Error("denied")
        items.set(key, value)
      },
      removeItem: (key: string) => {
        if (refuse) throw new Error("denied")
        items.delete(key)
      },
    }
    return { items, storage: () => storage }
  }

  test("nothing stored, unreadable or refused: the guide shows and nothing is skipped", () => {
    expect(readSetupPrefs(memory().storage)).toEqual(NO_PREFS)
    expect(readSetupPrefs(memory({ [SETUP_KEY]: "{not json" }).storage)).toEqual(NO_PREFS)
    expect(readSetupPrefs(memory({ [SETUP_KEY]: "[1]" }).storage)).toEqual(NO_PREFS)
    expect(readSetupPrefs(memory({}, true).storage)).toEqual(NO_PREFS)
  })

  test("stored as names under one key, read back; only the optional ones can be skipped", () => {
    const { items, storage } = memory()
    expect(storeSetupPrefs(storage, { hidden: true, skipped: ["offsite", "heartbeat", "offsite"] })).toBe(true)
    expect(JSON.parse(items.get(SETUP_KEY)!)).toEqual({ hidden: true, skipped: ["offsite"] })
    expect(readSetupPrefs(storage)).toEqual({ hidden: true, skipped: ["offsite"] })
    expect(readSetupPrefs(memory({ [SETUP_KEY]: JSON.stringify({ hidden: "yes", skipped: ["webhook", "company-signin", 3] }) }).storage)).toEqual({ hidden: false, skipped: ["company-signin"] })
  })

  test("back to nothing, the key goes; a storage that refuses says so", () => {
    const { items, storage } = memory({ [SETUP_KEY]: "{}" })
    expect(storeSetupPrefs(storage, NO_PREFS)).toBe(true)
    expect(items.has(SETUP_KEY)).toBe(false)
    expect(storeSetupPrefs(memory({}, true).storage, { hidden: true, skipped: [] })).toBe(false)
  })

  test("skipping and unskipping touch the one name", () => {
    const skipped = withSkipped(NO_PREFS, "offsite", true)
    expect(skipped.skipped).toEqual(["offsite"])
    expect(withSkipped(skipped, "company-signin", true).skipped).toEqual(["offsite", "company-signin"])
    expect(withSkipped(skipped, "offsite", false).skipped).toEqual([])
    expect(withSkipped(NO_PREFS, "heartbeat", true).skipped).toEqual([])
  })
})

describe("the guides' steps", () => {
  test("each guide's steps, and where Set up, Change and See progress open it", () => {
    expect(GUIDE_STEPS.heartbeat).toEqual(["create-check", "paste-ping", "wait-ping"])
    expect(GUIDE_STEPS.webhook).toEqual(["choose-service", "paste-webhook", "webhook-saved"])
    expect(GUIDE_STEPS.offsite).toEqual(["create-bucket", "bucket-details", "passphrase", "offsite-saved"])
    expect(GUIDE_STEPS["company-signin"]).toEqual(["register-app", "signin-details", "signin-saved"])
    expect(openingStep("heartbeat", "start")).toBe("create-check")
    expect(openingStep("heartbeat", "value")).toBe("paste-ping")
    expect(openingStep("heartbeat", "wait")).toBe("wait-ping")
    expect(openingStep("webhook", "value")).toBe("paste-webhook")
    expect(openingStep("offsite", "value")).toBe("bucket-details")
    expect(openingStep("company-signin", "value")).toBe("signin-details")
    for (const [id, step] of Object.entries(VALUE_STEP)) expect(GUIDE_STEPS[id as keyof typeof GUIDE_STEPS]).toContain(step)
  })

  test("Step 2 of 3, Back and Next", () => {
    expect(stepPosition("heartbeat", "paste-ping")).toEqual({ index: 2, total: 3, label: "Step 2 of 3" })
    expect(stepPosition("offsite", "passphrase").label).toBe("Step 3 of 4")
    expect(previousStep("heartbeat", "create-check")).toBeNull()
    expect(previousStep("offsite", "passphrase")).toBe("bucket-details")
    expect(nextStep("webhook", "choose-service")).toBe("paste-webhook")
    expect(nextStep("webhook", "webhook-saved")).toBeNull()
  })

  test("the monitor's and the backups' files, made by hand once, come first when they are missing", () => {
    expect(missingFile("heartbeat", "no-file")).toBe(MONITOR_FILE)
    expect(missingFile("webhook", "no-file")).toBe(MONITOR_FILE)
    expect(missingFile("offsite", "no-file")).toBe(BACKUP_FILE)
    expect(missingFile("heartbeat", "not-set")).toBeNull()
    expect(missingFile("company-signin", "no-file")).toBeNull()
  })

  test("the command is shown cut before the file's name, the copy holding the whole line", () => {
    const command = fileCommand(MONITOR_FILE)
    expect(command.whole).toBe("sudo install -m 600 -o root -g root /dev/null /etc/sitesolide/dashboard-monitor.env")
    expect(command.shown).not.toContain(".env")
    expect(command.whole.startsWith(command.shown.replace(" …", ""))).toBe(true)
  })
})

describe("what a guide accepts", () => {
  test("the ping URL: https, and a check's page is not its ping URL", () => {
    expect(pingCheck("")).toEqual({ hints: [], ready: false })
    expect(pingCheck("http://hc-ping.com/x")).toEqual({ hints: [{ text: "Use an https:// address: the monitor refuses plain http.", tone: "attention" }], ready: false })
    expect(pingCheck("https://healthchecks.io/checks/0b7c/details/")).toMatchObject({ ready: true, hints: [{ tone: "attention" }] })
    expect(pingCheck("https://hc-ping.com/0b7c1e20-0000-4000-8000-000000000000")).toEqual({ hints: [], ready: true })
  })

  test("the webhook: the format read from the address, and what is off for the service chosen", () => {
    expect(webhookCheck("https://hooks.slack.com/services/T0/B0/x", "slack")).toEqual({ hints: [{ text: "Format: Slack, read from the address.", tone: "plain" }], ready: true })
    expect(webhookCheck("https://hooks.example.test/x", "slack").hints).toEqual([{ text: "This doesn't look like a Slack address. Check it before saving.", tone: "attention" }])
    expect(webhookCheck("https://ntfy.example.test/topic", "ntfy").hints[0]!.text).toBe("This isn't ntfy.sh, so the format will be set to Plain text.")
    expect(webhookCheck("https://ntfy.sh/topic", "ntfy").hints.map((hint) => hint.text)).toEqual([
      "Format: Plain text (ntfy), read from the address.",
      "ntfy.sh topics are public: pick a topic nobody would guess.",
    ])
    expect(webhookCheck("https://hooks.example.test/x", "other").hints).toEqual([])
    // A Change, the service not known: the format the address says.
    expect(webhookCheck("https://discord.com/api/webhooks/1/x", null).hints).toEqual([{ text: "Format: Discord, read from the address.", tone: "plain" }])
    expect(webhookCheck("http://hooks.slack.com/x", "slack").ready).toBe(false)
  })

  test("the format saved: the service's own, Other's choice, or a Change's", () => {
    expect(wantedFormat("slack", "auto", "https://hooks.example.test/x")).toBe("slack")
    expect(wantedFormat("ntfy", "auto", "https://ntfy.sh/t")).toBe("text")
    expect(wantedFormat("other", "auto", "https://hooks.example.test/x")).toBe("json")
    expect(wantedFormat("other", "text", "https://hooks.example.test/x")).toBe("text")
    expect(wantedFormat(null, "auto", "https://chat.googleapis.com/v1/spaces/A/messages")).toBe("googlechat")
    expect(wantedFormat(null, "keep", "https://hooks.example.test/x")).toBeNull()
    expect(initialFormatChoice(true)).toBe("keep")
    expect(initialFormatChoice(false)).toBe("auto")
  })

  test("the format's own variable: set when the address does not say it, removed when kept for nothing, untouched otherwise", () => {
    expect(formatWrite("slack", "https://hooks.example.test/x", false)).toEqual({ variable: "ALERT_WEBHOOK_FORMAT", value: "slack" })
    expect(formatWrite("slack", "https://hooks.slack.com/services/x", true)).toEqual({ variable: "ALERT_WEBHOOK_FORMAT", remove: true })
    expect(formatWrite("slack", "https://hooks.slack.com/services/x", false)).toBeNull()
    expect(formatWrite(null, "https://hooks.example.test/x", true)).toBeNull()
    expect(formatSummary("slack", "https://hooks.slack.com/services/x")).toBe("Slack, read from the address")
    expect(formatSummary("text", "https://hooks.example.test/x")).toBe("Plain text (ntfy), as you chose")
    expect(formatSummary(null, "")).toBe("As before")
  })

  test("an endpoint and an issuer: https only", () => {
    expect(httpsProblem("")).toBeNull()
    expect(httpsProblem("https://s3.example.test")).toBeNull()
    expect(httpsProblem("http://s3.example.test")).toBe("Use an https:// address.")
    expect(httpsProblem("s3.example.test")).toBe("That isn't an address. Start it with https://.")
  })

  test("the bucket's details: all of them on a first setup, both keys together on a Change, the rest kept", () => {
    const all = { BACKUP_S3_ENDPOINT: "https://s3.example.test", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "s" }
    expect(offsiteDetailsReady(all, [])).toBe(true)
    expect(offsiteDetailsReady({ ...all, BACKUP_S3_SECRET_ACCESS_KEY: "" }, [])).toBe(false)
    expect(offsiteDetailsReady({ ...all, BACKUP_S3_ENDPOINT: "http://s3.example.test" }, [])).toBe(false)
    expect(offsiteDetailsReady({}, OFFSITE_FIVE)).toBe(true)
    expect(offsiteDetailsReady({ BACKUP_S3_ACCESS_KEY_ID: "new" }, OFFSITE_FIVE)).toBe(false)
    expect(offsiteDetailsReady({ BACKUP_S3_BUCKET: "other" }, OFFSITE_FIVE)).toBe(true)
    expect(offsiteDetailsReady({}, OFFSITE_FIVE.slice(0, 2))).toBe(false)
  })

  test("the passphrase: 16 characters and saved, or left empty on a Change to keep it", () => {
    expect(passphraseHint("short")).toEqual({ text: "5 of 16 characters minimum.", tone: "plain" })
    expect(passphraseHint("")).toBeNull()
    expect(passphraseHint("x".repeat(16))).toBeNull()
    expect(passphraseReady("x".repeat(16), false, false)).toBe(false)
    expect(passphraseReady("x".repeat(16), true, false)).toBe(true)
    expect(passphraseReady("x".repeat(15), true, false)).toBe(false)
    expect(passphraseReady("", true, false)).toBe(false)
    expect(passphraseReady("", false, true)).toBe(true)
  })

  test("a drawn passphrase: four groups of seven, from letters and digits nobody confuses", () => {
    const passphrase = drawPassphrase((bytes) => bytes.map((_, index) => index))
    expect(passphrase).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{7}(-[a-km-zA-HJ-NP-Z2-9]{7}){3}$/)
    expect(passphrase.replaceAll("-", "").length).toBeGreaterThanOrEqual(16)
    expect(drawPassphrase()).not.toBe(drawPassphrase())
  })

  test("company sign-in: issuer, client, secret and domains, typed or kept, the issuer in https", () => {
    const all = { OIDC_ISSUER: "https://accounts.example.test", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", OIDC_ALLOWED_DOMAINS: "example.test" }
    expect(signinReady(all, [])).toBe(true)
    expect(signinReady({ ...all, OIDC_ALLOWED_DOMAINS: " " }, [])).toBe(false)
    expect(signinReady({ ...all, OIDC_ISSUER: "http://accounts.example.test" }, [])).toBe(false)
    expect(signinReady({}, [...SIGNIN_THREE, "OIDC_ALLOWED_DOMAINS"])).toBe(true)
    expect(signinReady({}, SIGNIN_THREE)).toBe(false)
  })

  test("a form sends what is typed, trimmed, and leaves the rest as it is", () => {
    expect(writesOf({ BACKUP_S3_BUCKET: "  b ", BACKUP_S3_REGION: "", BACKUP_S3_PREFIX: " " }, OFFSITE_FIELDS)).toEqual([{ variable: "BACKUP_S3_BUCKET", value: "b" }])
    expect(writesOf({ OIDC_PROVIDER_NAME: "Example" }, SIGNIN_FIELDS)).toEqual([{ variable: "OIDC_PROVIDER_NAME", value: "Example" }])
  })

  test("the fields' plain labels; the secrets masked", () => {
    expect(OFFSITE_FIELDS.map((field) => field.label)).toEqual(["Endpoint", "Bucket", "Access key", "Secret key", "Region", "Folder"])
    expect(SIGNIN_FIELDS.map((field) => field.label)).toEqual(["Issuer", "Client ID", "Client secret", "Allowed domains", "Admin emails", "Provider name"])
    expect(OFFSITE_FIELDS.filter((field) => field.secret).map((field) => field.label)).toEqual(["Access key", "Secret key"])
    expect(SIGNIN_FIELDS.filter((field) => field.optional).map((field) => field.label)).toEqual(["Admin emails", "Provider name"])
  })
})

describe("reveal, remove and the sidebar", () => {
  test("Reveal shows the setting's values by their plain labels; the webhook's carries its format", () => {
    const states = settingState(server({ monitor: ["HEARTBEAT_URL", "ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_FORMAT"], backup: OFFSITE_FIVE }), [], alerting())
    expect(revealedOf("webhook", states)).toEqual([
      { variable: "ALERT_WEBHOOK_URL", label: "Webhook address" },
      { variable: "ALERT_WEBHOOK_FORMAT", label: "Message format" },
    ])
    expect(revealedOf("offsite", states).map((one) => one.label)).toEqual(["Endpoint", "Bucket", "Access key", "Secret key", "Encryption passphrase"])
    expect(removalOf("webhook", states)).toEqual([
      { variable: "ALERT_WEBHOOK_URL", remove: true },
      { variable: "ALERT_WEBHOOK_FORMAT", remove: true },
    ])
    expect(removalOf("heartbeat", states)).toEqual([{ variable: "HEARTBEAT_URL", remove: true }])
  })

  test("the Server entry: a dot while the heartbeat is not set, red while it fails, nothing otherwise", () => {
    expect(serverSignal(null)).toBeNull()
    expect(serverSignal(settingState(server({ monitor: null }), [], null))).toEqual({ tone: "attention", label: "heartbeat not set" })
    expect(serverSignal(settingState(server({ monitor: [] }), [], null))).toEqual({ tone: "attention", label: "heartbeat not set" })
    expect(serverSignal(settingState(server(), [], alerting({ heartbeat: "failed" })))).toEqual({ tone: "error", label: "heartbeat failed" })
    expect(serverSignal(settingState(server(), [], alerting()))).toBeNull()
    expect(machineIndicators(null, { tone: "attention", label: "heartbeat not set" }).server).toEqual({ count: 1, tone: "attention", label: "heartbeat not set", dot: true })
  })
})

describe("what the review found", () => {
  test("a save cut partway says what is on the server now, in plain words", () => {
    expect(partialSave(["BACKUP_S3_ACCESS_KEY_ID"], ["BACKUP_S3_SECRET_ACCESS_KEY"])).toBe("The access key was saved, the secret key wasn't. Save again to finish.")
    expect(partialSave(["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET"], ["BACKUP_S3_ACCESS_KEY_ID", "BACKUP_ENCRYPTION_PASSPHRASE"])).toBe(
      "The endpoint and the bucket were saved, the access key and the encryption passphrase weren't. Save again to finish.",
    )
    expect(partialSave(["ALERT_WEBHOOK_URL"], ["ALERT_WEBHOOK_FORMAT"])).toBe("The webhook address was saved, the message format wasn't. Save again to finish.")
    expect(partialSave(["OIDC_ISSUER"], ["OIDC_CLIENT_ID"])).toBe("The issuer was saved, the client ID wasn't. Save again to finish.")
    // Nothing went through, or everything did: nothing partial to say.
    expect(partialSave([], ["HEARTBEAT_URL"])).toBeNull()
    expect(partialSave(["HEARTBEAT_URL"], [])).toBeNull()
  })

  test("the unlock is asked before the first write when it would not last the save", () => {
    expect(unlockFirst({ open: false })).toBe(true)
    expect(unlockFirst({ open: true, remainingMs: UNLOCK_MARGIN_MS - 1 })).toBe(true)
    expect(unlockFirst({ open: true, remainingMs: 9 * MINUTE })).toBe(false)
  })

  test("a Change with every field left as it is writes nothing", () => {
    expect(offsiteWrites({}, "")).toEqual([])
    expect(offsiteWrites({ BACKUP_S3_BUCKET: " " }, "")).toEqual([])
    expect(writesOf({}, SIGNIN_FIELDS)).toEqual([])
    expect(offsiteWrites({ BACKUP_S3_REGION: "eu-west-1" }, "a passphrase of sixteen")).toEqual([
      { variable: "BACKUP_S3_REGION", value: "eu-west-1" },
      { variable: "BACKUP_ENCRYPTION_PASSPHRASE", value: "a passphrase of sixteen" },
    ])
  })

  test("Other shows the format it writes, whatever was chosen before", () => {
    for (const choice of ["keep", "auto", "json", "slack"] as const) {
      expect(otherFormat(choice)).toBe("json")
      expect(wantedFormat("other", choice, "https://hooks.example.test/x")).toBe("json")
    }
    expect(otherFormat("text")).toBe("text")
    expect(wantedFormat("other", "text", "https://hooks.example.test/x")).toBe("text")
  })

  test("a heartbeat the monitor refuses, with no save awaited here, is Failed, and the sidebar's dot red", () => {
    // A pass after the file's last change found no address it would ping.
    const refused = inputs(server(), { alerting: alerting({ heartbeat: "unconfigured", at: NOW - 20 * SECOND }) })
    expect(serverRow("heartbeat", refused)).toMatchObject({ word: "Failed", tone: "error", error: true, extra: "the monitor didn't take the address" })
    expect(serverSignal(refused.states, refused.alerting)).toEqual({ tone: "error", label: "heartbeat failed" })
    expect(sitesRows(sites(refused))[0]).toMatchObject({ id: "heartbeat", word: "Failed", line: "The monitor didn't take this address. Check the URL." })
    // Its last pass came before the change: it is waiting, not refusing.
    const waiting = inputs(server(), { alerting: alerting({ heartbeat: "unconfigured", at: NOW - 40 * MINUTE }) })
    expect(serverRow("heartbeat", waiting)).toMatchObject({ word: "Set", extra: "not pinged yet", error: false })
    expect(serverSignal(waiting.states, waiting.alerting)).toBeNull()
  })

  test("the portal's file missing: company sign-in says so in red and leads to the reason, and the guide leaves it out", () => {
    const projects = server()
    projects[1] = secretProject({ slug: "portal", files: [secretFile({ name: "portal.env", state: "absent", variables: [], passwords: [], modifiedAt: null })] })
    const row = inputs(projects, { skipped: new Set(["offsite"]) })
    expect(serverRow("company-signin", row)).toMatchObject({ word: "Missing", tone: "error", error: true, action: { kind: "secrets", label: "See why", slug: "portal" }, menu: [] })
    expect(sitesRowIds(sites(row))).toEqual([])
  })

  test("the words of a ping that came, and of one the page can't confirm, name no service", () => {
    const proof: Proof = { savedAt: NOW - 30 * SECOND, deliveredAt: null, seen: false }
    const unknown = inputs(server(), { alerting: null, proof })
    expect(sitesRows(sites(unknown, { guideOpen: "heartbeat" }))[0]).toMatchObject({ line: "The monitor pings it at its next pass, within a minute." })
  })
})

describe("the words", () => {
  test("an age in words", () => {
    expect(changedWords(5 * SECOND)).toBe("just now")
    expect(changedWords(30 * SECOND)).toBe("30 seconds ago")
    expect(changedWords(MINUTE)).toBe("1 minute ago")
    expect(changedWords(35 * MINUTE)).toBe("35 minutes ago")
    expect(changedWords(26 * 60 * MINUTE)).toBe("1 day ago")
    expect(changedWords(12 * DAY)).toBe("12 days ago")
  })

  test("the rows name no file and no variable", () => {
    const base = inputs(server({ monitor: [] }))
    const words = [...SERVER_GROUPS.flatMap((group) => group.rows.flatMap((id) => {
      const row = serverRow(id, base)
      const spec = rowSpec(id)
      return [spec.name, spec.serverLine, spec.sitesLine ?? "", row.word, row.extra ?? "", row.tip ?? ""]
    }))]
    for (const word of words) expect(word).not.toMatch(/\.env|[A-Z]{3,}_[A-Z_]+/)
  })

  test("English only, and no em dash or en dash, in the module and the components it feeds", async () => {
    const files = ["../src/lib/server-setup.ts", "../src/components/server-setup.tsx", "../src/components/setup-guide.tsx", "../src/components/setup-panel.tsx", "../src/components/pages/server.tsx"]
    for (const file of files) {
      const text = await Bun.file(new URL(file, import.meta.url)).text()
      for (const dash of DASHES) expect([file, text.includes(dash)]).toEqual([file, false])
    }
  })
})
