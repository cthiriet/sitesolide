import { describe, expect, test } from "bun:test"
import {
  ALERTS_UNDELIVERED_LABEL,
  GROUP_LABELS,
  HEARTBEAT_FAILED_LABEL,
  SETTINGS,
  WEBHOOK_FORMATS,
  alertAddressProblem,
  appliesOnRestart,
  detectedWebhookFormat,
  heartbeatPageHint,
  readingSentence,
  settingById,
  settingOfVariable,
  settingState,
  settingsOf,
  unrestartedSentence,
  webhookAddressHint,
  type SettingId,
} from "../src/lib/machine-settings"
import { PENDING_LABEL } from "../src/lib/secrets"
import type { Alerting } from "../src/lib/types"
import { discrepancy, secretFile, secretProject } from "./factory"

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const MONITOR_FILE = "dashboard-monitor.env"
const BACKUP_FILE = "dashboard-backup.env"

/** The dashboard as the steward lists it, with the files the test says. */
function dashboard(...files: Parameters<typeof secretFile>[0][]) {
  return secretProject({ slug: "dashboard", files: files.map((file) => secretFile({ expected: "root:root 0600", ...file })) })
}

const monitoring = (variables: string[], more: Parameters<typeof secretFile>[0] = {}) =>
  ({ name: MONITOR_FILE, variables, modifiedAt: NOW - 35 * MINUTE, ...more }) as const

const hash = { variables: ["PASSWORD_HASH"], passwords: ["PASSWORD_HASH"] }

// By code point, as tests/redaction.test.ts does: this file must not hold what it forbids.
const DASHES = [String.fromCodePoint(0x2014), String.fromCodePoint(0x2013)]

const alerting = (partial: Partial<Alerting> = {}): Alerting => ({ heartbeat: "ok", webhook: "ok", undelivered: 0, at: NOW, ...partial })

describe("when a change applies", () => {
  test("a restart applies the project's own file and nothing else", () => {
    expect(appliesOnRestart("dashboard", "dashboard.env")).toBe(true)
    expect(appliesOnRestart("portal", "portal.env")).toBe(true)
    expect(appliesOnRestart("dashboard", MONITOR_FILE)).toBe(false)
    expect(appliesOnRestart("dashboard", BACKUP_FILE)).toBe(false)
    // Another project's file is not this one's, whatever its name.
    expect(appliesOnRestart("dashboard", "portal.env")).toBe(false)
    expect(appliesOnRestart("portal", "dashboard.env")).toBe(false)
  })

  test("the monitor's file says it is read at its next pass, and that nothing restarts", () => {
    expect(unrestartedSentence("dashboard", MONITOR_FILE, "add")).toBe(
      "The monitor uses it at its next pass, within a minute. Nothing to restart.",
    )
    expect(unrestartedSentence("dashboard", MONITOR_FILE, "edit")).toBe(
      "The monitor uses the new value at its next pass, within a minute. Nothing to restart.",
    )
    expect(unrestartedSentence("dashboard", MONITOR_FILE, "remove")).toBe(
      "The monitor stops using it at its next pass, within a minute. Nothing to restart.",
    )
    expect(unrestartedSentence("dashboard", MONITOR_FILE, "restore")).toBe(
      "The monitor uses the previous version at its next pass, within a minute. Nothing to restart.",
    )
  })

  test("the backups' file says it is read by the next backup run", () => {
    expect(unrestartedSentence("dashboard", BACKUP_FILE, "add")).toBe(
      "The backup run uses it at its next start, within the hour. Nothing to restart.",
    )
    expect(unrestartedSentence("dashboard", BACKUP_FILE, "edit")).toContain("the new value")
  })

  test("a file a restart applies has no such sentence, so the dialogs keep their own words", () => {
    for (const change of ["add", "edit", "remove", "restore"] as const) {
      expect(unrestartedSentence("dashboard", "dashboard.env", change)).toBeNull()
      expect(unrestartedSentence("portal", "portal.env", change)).toBeNull()
    }
  })

  test("a file the catalogue does not know promises nothing", () => {
    expect(unrestartedSentence("dashboard", "dashboard-other.env", "edit")).toBe("No restart applies it.")
  })

  test("the Secrets intro: every file restarted, or one that reads them all when it starts, keeps its sentence", () => {
    expect(readingSentence("cms", [])).toBe("cms reads these when it starts: a change applies after a restart.")
    expect(readingSentence("portal", ["portal.env"])).toBe("portal reads these when it starts: a change applies after a restart.")
    expect(readingSentence("dashboard", ["dashboard.env"])).toBe("dashboard reads these when it starts: a change applies after a restart.")
  })

  test("the Secrets intro: the monitor's and the backups' files are read at their own pace", () => {
    expect(readingSentence("dashboard", ["dashboard.env", MONITOR_FILE])).toBe(
      "dashboard reads dashboard.env when it starts: a change applies after a restart. The other files are read by the monitor, each on its own schedule: nothing to restart.",
    )
    expect(readingSentence("dashboard", ["dashboard.env", MONITOR_FILE, BACKUP_FILE])).toContain("by the monitor and the backup run, each on its own schedule")
    expect(readingSentence("dashboard", ["dashboard.env", "dashboard-other.env"])).toContain("A restart does not apply the other files.")
  })

  test("a restart is never offered, and never promised, for the monitor's and the backups' files", () => {
    // The wording the dialogs used to give every platform file: a restart, or reading it when it starts.
    const restartWords = /restart|when it starts/i
    for (const file of [MONITOR_FILE, BACKUP_FILE]) {
      for (const change of ["add", "edit", "remove", "restore"] as const) {
        const sentence = unrestartedSentence("dashboard", file, change)!
        expect(sentence).toEndWith("Nothing to restart.")
        expect(sentence.replace("Nothing to restart.", "")).not.toMatch(restartWords)
      }
    }
    for (const setting of SETTINGS.filter((one) => !appliesOnRestart(one.slug, one.file))) {
      expect(setting.applies).toEndWith("Nothing to restart.")
    }
  })
})

describe("the catalogue", () => {
  test("each setting has its own id, and a file only its project lists", () => {
    expect(new Set(SETTINGS.map((setting) => setting.id)).size).toBe(SETTINGS.length)
    const files = { dashboard: ["dashboard.env", MONITOR_FILE, BACKUP_FILE], portal: ["portal.env"] }
    for (const setting of SETTINGS) expect(files[setting.slug]).toContain(setting.file)
  })

  test("a variable belongs to one setting, and every setting needs one to be set", () => {
    const seen = new Map<string, SettingId>()
    for (const setting of SETTINGS) {
      expect(setting.variables.some((variable) => variable.required)).toBe(true)
      for (const { name } of setting.variables) {
        const key = `${setting.file}/${name}`
        // The two passwords are the same variable name in two files.
        expect([key, seen.get(key)]).toEqual([key, undefined])
        seen.set(key, setting.id)
      }
    }
  })

  test("a variable is found with its setting", () => {
    expect(settingOfVariable("dashboard", MONITOR_FILE, "HEARTBEAT_URL")?.id).toBe("heartbeat")
    expect(settingOfVariable("portal", "portal.env", "OIDC_CLIENT_SECRET")?.id).toBe("company-signin")
    expect(settingOfVariable("portal", "portal.env", "PASSWORD_HASH")?.id).toBe("portal-password")
    expect(settingOfVariable("dashboard", MONITOR_FILE, "HEARTBEAT_ULR")).toBeNull()
  })

  test("the groups hold the settings the page puts under them", () => {
    expect(settingsOf("monitoring").map((setting) => setting.id)).toEqual(["heartbeat", "webhook", "format"])
    expect(settingsOf("sign-in").map((setting) => setting.id)).toEqual(["dashboard-password", "portal-password", "company-signin"])
    expect(settingsOf("offsite").map((setting) => setting.id)).toEqual(["offsite"])
    expect(Object.values(GROUP_LABELS)).toEqual(["Monitoring", "Sign-in", "Offsite copy"])
  })

  test("the sentences the plan gives", () => {
    expect(settingById("heartbeat").applies).toBe("The monitor uses it at its next pass, within a minute. Nothing to restart.")
    expect(settingById("company-signin").applies).toBe("The portal reads these when it starts: restart it to apply a change.")
    expect(settingById("dashboard-password").applies).toContain("that restart signs everyone out")
    expect(settingById("portal-password").applies).toContain("once the portal restarts")
  })

  test("English only, and no em dash or en dash", () => {
    const words = SETTINGS.flatMap((setting) => [
      setting.label,
      setting.reader,
      setting.applies,
      setting.hint,
      ...setting.variables.map((variable) => variable.label),
    ])
    for (const word of [...words, ...Object.values(GROUP_LABELS), ...WEBHOOK_FORMATS.map((format) => format.label)]) {
      for (const dash of DASHES) expect(word).not.toContain(dash)
      expect(word).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe("the addresses the monitor accepts", () => {
  test("nothing typed is no problem; https is taken", () => {
    expect(alertAddressProblem("")).toBeNull()
    expect(alertAddressProblem("   ")).toBeNull()
    expect(alertAddressProblem("https://hc-ping.example.test/0b7c")).toBeNull()
    expect(alertAddressProblem("  https://hc-ping.example.test/0b7c  ")).toBeNull()
  })

  test("plain http, another scheme and a word that is no address each have their reason", () => {
    expect(alertAddressProblem("http://hc-ping.example.test/0b7c")).toBe("Use an https:// address: the monitor refuses plain http.")
    expect(alertAddressProblem("ftp://files.example.test/")).toBe("Use an https:// address: the monitor refuses any other kind.")
    expect(alertAddressProblem("hc-ping.example.test/0b7c")).toBe("That isn't an address. Start it with https://.")
    expect(alertAddressProblem("not an address")).toBe("That isn't an address. Start it with https://.")
  })

  test("the format is read from the address, as the monitor does", () => {
    expect(detectedWebhookFormat("https://hooks.slack.com/services/T0/B0/x")).toBe("slack")
    expect(detectedWebhookFormat("https://discord.com/api/webhooks/1/x")).toBe("discord")
    expect(detectedWebhookFormat("https://canary.discord.com/api/webhooks/1/x")).toBe("discord")
    expect(detectedWebhookFormat("https://discordapp.com/api/webhooks/1/x")).toBe("discord")
    expect(detectedWebhookFormat("https://chat.googleapis.com/v1/spaces/A/messages?key=k")).toBe("googlechat")
    expect(detectedWebhookFormat("https://ntfy.sh/a-topic")).toBe("text")
  })

  test("any other address, an address the monitor refuses and nothing at all read as json", () => {
    expect(detectedWebhookFormat("https://ntfy.example.test/a-topic")).toBe("json")
    expect(detectedWebhookFormat("https://notdiscord.com/x")).toBe("json")
    expect(detectedWebhookFormat("http://hooks.slack.com/services/x")).toBe("json")
    expect(detectedWebhookFormat("hooks.slack.com")).toBe("json")
    expect(detectedWebhookFormat("")).toBe("json")
  })

  test("the formats a choice offers are the five the monitor speaks, Slack first", () => {
    expect(WEBHOOK_FORMATS.map((format) => format.value)).toEqual(["slack", "discord", "googlechat", "text", "json"])
    expect(WEBHOOK_FORMATS.find((format) => format.value === "text")?.label).toBe("Plain text (ntfy)")
  })

  test("a check's page is not its ping URL", () => {
    expect(heartbeatPageHint("https://healthchecks.io/checks/0b7c1e20-0000-4000-8000-000000000000/details/")).toBe(
      "This is the check's page. Copy its ping URL instead, https://hc-ping.com/…",
    )
    expect(heartbeatPageHint("https://hc.example.test/checks/0b7c/details/")).toBe("This looks like the check's page. Copy its ping URL instead.")
    expect(heartbeatPageHint("https://hc-ping.com/0b7c1e20-0000-4000-8000-000000000000")).toBeNull()
    expect(heartbeatPageHint("http://healthchecks.io/checks/x/")).toBeNull()
    expect(heartbeatPageHint("")).toBeNull()
  })

  test("an ntfy.sh topic is public", () => {
    expect(webhookAddressHint("https://ntfy.sh/a-topic")).toBe("ntfy.sh topics are public: pick a topic nobody would guess.")
    expect(webhookAddressHint("https://ntfy.example.test/a-topic")).toBeNull()
    expect(webhookAddressHint("https://hooks.slack.com/services/x")).toBeNull()
    expect(webhookAddressHint("http://ntfy.sh/a-topic")).toBeNull()
  })
})

describe("where a setting stands", () => {
  const all = (projects: Parameters<typeof settingState>[0], found = alerting(), issues = [] as ReturnType<typeof discrepancy>[]) =>
    settingState(projects, issues, found)

  test("before the secrets are loaded, nothing is known and nothing is said", () => {
    const states = all(null)
    for (const setting of SETTINGS) {
      expect(states[setting.id]).toMatchObject({ presence: "unknown", present: [], changedAt: null, restartPending: false, channel: null, tone: "neutral", label: "" })
    }
  })

  test("a project the steward does not list is as unknown", () => {
    expect(all([secretProject({ slug: "cms" })])["heartbeat"].presence).toBe("unknown")
  })

  test("the monitor's file is listed only once the owner made it: until then the settings say the file is missing", () => {
    const states = all([dashboard({ name: "dashboard.env", ...hash })], alerting({ heartbeat: "unconfigured", webhook: "unconfigured" }))
    for (const id of ["heartbeat", "webhook", "format"] as const) {
      expect(states[id]).toMatchObject({ presence: "no-file", tone: "attention", label: "File missing", channel: null })
    }
    expect(states["offsite"]).toMatchObject({ presence: "no-file", tone: "attention", label: "File missing" })
  })

  test("a file that holds none of a setting's variables: the heartbeat and the webhook are worth a look, the format is not", () => {
    const states = all([dashboard(monitoring([]))], alerting({ heartbeat: "unconfigured", webhook: "unconfigured" }))
    expect(states["heartbeat"]).toMatchObject({ presence: "not-set", tone: "attention", label: "Not set", present: [], changedAt: NOW - 35 * MINUTE })
    expect(states["webhook"]).toMatchObject({ presence: "not-set", tone: "attention", label: "Not set" })
    expect(states["format"]).toMatchObject({ presence: "not-set", tone: "neutral", label: "Not set" })
  })

  test("set, and the monitor says it works", () => {
    const states = all([dashboard(monitoring(["HEARTBEAT_URL", "ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_FORMAT"]))], alerting({ webhook: "idle" }))
    expect(states["heartbeat"]).toMatchObject({ presence: "set", present: ["HEARTBEAT_URL"], channel: "ok", tone: "neutral", label: "Set" })
    expect(states["webhook"]).toMatchObject({ presence: "set", channel: "idle", tone: "neutral", label: "Set", undelivered: 0 })
    expect(states["format"]).toMatchObject({ presence: "set", present: ["ALERT_WEBHOOK_FORMAT"], channel: null })
  })

  test("set, and the monitor says it fails: red, with the notices waiting", () => {
    const states = all(
      [dashboard(monitoring(["HEARTBEAT_URL", "ALERT_WEBHOOK_URL"]))],
      alerting({ heartbeat: "failed", webhook: "failed", undelivered: 3 }),
    )
    expect(states["heartbeat"]).toMatchObject({ channel: "failed", tone: "error", label: "Failed" })
    expect(states["webhook"]).toMatchObject({ channel: "failed", tone: "error", label: "Failed", undelivered: 3 })
  })

  test("an address in the file the monitor has not taken up yet is waiting, not failed", () => {
    const states = all([dashboard(monitoring(["HEARTBEAT_URL"]))], alerting({ heartbeat: "unconfigured", webhook: "unconfigured" }))
    expect(states["heartbeat"]).toMatchObject({ presence: "set", channel: "waiting", tone: "neutral", label: "Waiting" })
    expect(states["webhook"]).toMatchObject({ presence: "not-set", channel: null })
  })

  test("a monitor that says nothing now is not taken for one that says all is well", () => {
    const projects = [dashboard(monitoring(["HEARTBEAT_URL", "ALERT_WEBHOOK_URL"]))]
    expect(settingState(projects, [], null)["heartbeat"]).toMatchObject({ channel: "unknown", label: "Set" })
    expect(settingState(projects, [], undefined)["webhook"]).toMatchObject({ channel: "unknown", label: "Set" })
  })

  test("a server from before the field still says a channel failed, through its Issues", () => {
    const projects = [dashboard(monitoring(["HEARTBEAT_URL", "ALERT_WEBHOOK_URL"]))]
    const issues = [discrepancy("warning", null, "m", HEARTBEAT_FAILED_LABEL), discrepancy("warning", null, "m", ALERTS_UNDELIVERED_LABEL)]
    const states = settingState(projects, issues, undefined)
    expect(states["heartbeat"]).toMatchObject({ channel: "failed", tone: "error", label: "Failed" })
    expect(states["webhook"]).toMatchObject({ channel: "failed", tone: "error", label: "Failed" })
    // The field, when the server sends it, decides: an Issue of another site's is no word on the channels.
    expect(settingState(projects, [discrepancy("warning", "cms", "m", HEARTBEAT_FAILED_LABEL)], undefined)["heartbeat"].channel).toBe("unknown")
  })

  test("an address is not a channel until it is set", () => {
    const states = all([dashboard(monitoring([]))], alerting({ heartbeat: "failed", webhook: "failed", undelivered: 3 }), [
      discrepancy("warning", null, "m", HEARTBEAT_FAILED_LABEL),
    ])
    expect(states["heartbeat"]).toMatchObject({ presence: "not-set", channel: null, label: "Not set" })
  })

  test("a file the steward does not rewrite cannot be changed from the page", () => {
    const states = all([dashboard({ name: BACKUP_FILE, state: "unmanaged", reason: "several hard links", variables: [], modifiedAt: NOW })])
    expect(states["offsite"]).toMatchObject({ presence: "unmanaged", tone: "attention", label: "Unmanaged", present: [], changedAt: NOW })
  })

  test("the offsite copy needs all five to be set; some of them is incomplete, the optional two alone as well", () => {
    const five = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_ENCRYPTION_PASSPHRASE"]
    const state = (variables: string[]) => all([dashboard({ name: BACKUP_FILE, variables })])["offsite"]
    expect(state([])).toMatchObject({ presence: "not-set", tone: "neutral", label: "Not set" })
    expect(state(five)).toMatchObject({ presence: "set", missing: [], label: "Set" })
    expect(state([...five, "BACKUP_S3_REGION", "BACKUP_S3_PREFIX"]).present).toHaveLength(7)
    expect(state(five.slice(0, 4))).toMatchObject({ presence: "incomplete", tone: "attention", label: "Incomplete", missing: ["BACKUP_ENCRYPTION_PASSPHRASE"] })
    expect(state(["BACKUP_S3_REGION"])).toMatchObject({ presence: "incomplete", missing: five })
  })

  test("a variable no setting names is no part of one", () => {
    const state = all([dashboard(monitoring(["HEARTBEAT_ULR", "BACKUP_KEEP_DAILY"]))])["heartbeat"]
    expect(state).toMatchObject({ presence: "not-set", present: [] })
  })

  test("the company sign-in needs its issuer, client and secret; the rest refine it", () => {
    const portal = (variables: string[]) => secretProject({ slug: "portal", files: [secretFile({ name: "portal.env", variables: ["PASSWORD_HASH", ...variables], passwords: ["PASSWORD_HASH"] })] })
    const state = (variables: string[]) => all([portal(variables)])["company-signin"]
    expect(state([])).toMatchObject({ presence: "not-set", tone: "neutral", label: "Not set" })
    expect(state(["OIDC_ISSUER", "OIDC_CLIENT_ID"])).toMatchObject({ presence: "incomplete", missing: ["OIDC_CLIENT_SECRET"] })
    expect(state(["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"])).toMatchObject({ presence: "set", present: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] })
    expect(state(["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_PROVIDER_NAME"]).present).toHaveLength(4)
  })

  test("a password is a hash in its file; its own file missing is red", () => {
    const projects = [dashboard({ name: "dashboard.env", ...hash }), secretProject({ slug: "portal", files: [secretFile({ name: "portal.env", state: "absent", variables: [], passwords: [] })] })]
    const states = all(projects)
    expect(states["dashboard-password"]).toMatchObject({ presence: "set", label: "Set", tone: "neutral" })
    expect(states["portal-password"]).toMatchObject({ presence: "no-file", tone: "error", label: "File missing" })
  })

  test("a restart pending is the portal's and the dashboard's own file, never the monitor's", () => {
    const projects = [
      dashboard({ name: "dashboard.env", ...hash, restartPending: true }, monitoring(["HEARTBEAT_URL"], { restartPending: true })),
      secretProject({ slug: "portal", files: [secretFile({ name: "portal.env", variables: ["PASSWORD_HASH", "OIDC_ISSUER"], passwords: ["PASSWORD_HASH"], restartPending: true })] }),
    ]
    const states = all(projects)
    expect(states["dashboard-password"]).toMatchObject({ restartPending: true, tone: "attention", label: PENDING_LABEL })
    expect(states["portal-password"]).toMatchObject({ restartPending: true, label: PENDING_LABEL })
    expect(states["company-signin"]).toMatchObject({ restartPending: true, presence: "incomplete", label: "Incomplete" })
    // Even if a steward said so, no restart applies the monitor's file.
    expect(states["heartbeat"]).toMatchObject({ restartPending: false, label: "Set" })
  })

  test("a failure outranks a restart pending, and the date is the file's", () => {
    const states = all([dashboard(monitoring(["HEARTBEAT_URL"], { modifiedAt: NOW - 2 * MINUTE }))], alerting({ heartbeat: "failed" }))
    expect(states["heartbeat"]).toMatchObject({ tone: "error", changedAt: NOW - 2 * MINUTE })
  })
})
