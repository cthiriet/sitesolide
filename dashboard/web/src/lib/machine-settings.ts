/**
 * The server's own settings, as the page names them. Pure.
 *
 * They are variables of the platform's flat files in /etc/sitesolide, which
 * the steward lists under the dashboard's and the portal's sites
 * (`PLATFORM_FILES` in src/secrets/scope.ts): how the monitor tells the owner
 * the server is down, who signs in, where the backups go. This module is the
 * one place that says which file and variables make up each setting, who
 * reads them and when a change applies, so that every page that offers one
 * says the same thing.
 *
 * Like the rest of the page it judges nothing the steward judges: a value is
 * sent as typed and the steward's refusal is shown. What it copies, for want of
 * importing the services, are the few rules the page can show before sending,
 * `alertAddressProblem` and `detectedWebhookFormat` from monitor/src/notify.ts,
 * and `appliesOnRestart` from the steward's `service.reads`. Each is confronted
 * with the original in dashboard/tests/agreement-page.test.ts, so that none of
 * them drifts in silence.
 *
 * Nothing here holds a value, and nothing here reads one: a setting's state is
 * made of the names the steward lists, the dates it gives, and what the monitor
 * says of its two channels.
 */
import { capitalise } from "./format"
import { passwordTexts } from "./password"
import { PENDING_LABEL } from "./secrets"
import type { Tone } from "./tones"
import type { Alerting, Discrepancy, ProjectView } from "./types"

// --- When a change applies -----------------------------------------------------

/**
 * Does a restart of the project's service apply a change to this file? Only
 * the project's own `<slug>.env`, the one its unit reads through
 * `EnvironmentFile=` (`platformFile` in bin/cli/unit.ts). The monitor's and the
 * backups' files are the dashboard site's, listed beside its own, but read by
 * units of their own at their own next pass, so the steward never marks them
 * pending (`restartPending` in src/secrets/steward.ts) and a restart of the
 * dashboard applies nothing of theirs.
 */
export function appliesOnRestart(slug: string, file: string): boolean {
  return file === `${slug}.env`
}

/** A change to a file, as the dialogs name it. */
export type FileChange = "add" | "edit" | "remove" | "restore"

/** What a change does for a file read at its reader's own pace: who reads it, and when. */
type Cadence = { reader: string; when: string }

/** The sentence a change ends on when no restart is needed, "The monitor uses it at its next pass, within a minute. Nothing to restart." */
function noRestart({ reader, when }: Cadence, change: FileChange): string {
  const does: Record<FileChange, string> = {
    add: "uses it",
    edit: "uses the new value",
    remove: "stops using it",
    restore: "uses the previous version",
  }
  return `${capitalise(reader)} ${does[change]} ${when}. Nothing to restart.`
}

const MONITOR_CADENCE: Cadence = { reader: "the monitor", when: "at its next pass, within a minute" }
const BACKUP_CADENCE: Cadence = { reader: "the backup run", when: "at its next start, within the hour" }

// --- The catalogue -------------------------------------------------------------

export type SettingId =
  | "heartbeat"
  | "webhook"
  | "format"
  | "dashboard-password"
  | "portal-password"
  | "company-signin"
  | "offsite"

/** How the page groups them: a panel each. */
export type SettingGroup = "monitoring" | "sign-in" | "offsite"

export const GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
  monitoring: "Monitoring",
  "sign-in": "Sign-in",
  offsite: "Offsite copy",
}

export type SettingVariable = {
  /** The name in the file. */
  name: string
  /** What a row or a field calls it. */
  label: string
  /** The setting is not set without it. The others refine it. */
  required: boolean
}

export type MachineSetting = {
  id: SettingId
  group: SettingGroup
  /** What the page calls it. */
  label: string
  /** The platform project that lists its file. */
  slug: "dashboard" | "portal"
  /** The flat file under /etc/sitesolide that holds its variables. */
  file: string
  /** Its variables, in the order a form asks for them. */
  variables: readonly SettingVariable[]
  /** Who reads the file, as a noun phrase in a sentence: "the monitor". */
  reader: string
  /** The sentence saying when a change applies. */
  applies: string
  /** The same in a few words, for a menu: "applies within a minute". */
  hint: string
  /**
   * A server is expected to have it: when it does not, the page says so as
   * something worth a look. The others are optional, and their absence is
   * quiet.
   */
  expected: boolean
}

const PASSWORD_HASH = "PASSWORD_HASH"

/**
 * The settings, in the order a page lists them. Retention (`BACKUP_KEEP_*`) and
 * `BACKUP_DISK_RESERVE` are not among them: they stay in the raw Files list of
 * the dashboard's Secrets.
 */
export const SETTINGS: readonly MachineSetting[] = [
  {
    id: "heartbeat",
    group: "monitoring",
    label: "Heartbeat",
    slug: "dashboard",
    file: "dashboard-monitor.env",
    variables: [{ name: "HEARTBEAT_URL", label: "Ping URL", required: true }],
    reader: MONITOR_CADENCE.reader,
    applies: noRestart(MONITOR_CADENCE, "add"),
    hint: "applies within a minute",
    expected: true,
  },
  {
    id: "webhook",
    group: "monitoring",
    label: "Alert webhook",
    slug: "dashboard",
    file: "dashboard-monitor.env",
    variables: [{ name: "ALERT_WEBHOOK_URL", label: "Webhook URL", required: true }],
    reader: MONITOR_CADENCE.reader,
    applies: noRestart(MONITOR_CADENCE, "add"),
    hint: "applies within a minute",
    expected: true,
  },
  {
    id: "format",
    group: "monitoring",
    label: "Message format",
    slug: "dashboard",
    file: "dashboard-monitor.env",
    variables: [{ name: "ALERT_WEBHOOK_FORMAT", label: "Format", required: true }],
    reader: MONITOR_CADENCE.reader,
    applies: noRestart(MONITOR_CADENCE, "add"),
    hint: "applies within a minute",
    expected: false,
  },
  {
    id: "dashboard-password",
    group: "sign-in",
    label: "Dashboard password",
    slug: "dashboard",
    file: "dashboard.env",
    variables: [{ name: PASSWORD_HASH, label: "Password", required: true }],
    reader: "the dashboard",
    applies: passwordTexts("dashboard", PASSWORD_HASH).warning,
    hint: "on restart, signs everyone out",
    expected: true,
  },
  {
    id: "portal-password",
    group: "sign-in",
    label: "Portal password",
    slug: "portal",
    file: "portal.env",
    variables: [{ name: PASSWORD_HASH, label: "Password", required: true }],
    reader: "the portal",
    applies: passwordTexts("portal", PASSWORD_HASH).warning,
    hint: "applies when the portal restarts",
    expected: true,
  },
  {
    id: "company-signin",
    group: "sign-in",
    label: "Company sign-in",
    slug: "portal",
    file: "portal.env",
    variables: [
      { name: "OIDC_ISSUER", label: "Issuer address", required: true },
      { name: "OIDC_CLIENT_ID", label: "Client ID", required: true },
      { name: "OIDC_CLIENT_SECRET", label: "Client secret", required: true },
      { name: "OIDC_ALLOWED_DOMAINS", label: "Allowed domains", required: false },
      { name: "OIDC_ADMIN_EMAILS", label: "Admin emails", required: false },
      { name: "OIDC_PROVIDER_NAME", label: "Provider name", required: false },
    ],
    reader: "the portal",
    applies: "The portal reads these when it starts: restart it to apply a change.",
    hint: "applies when the portal restarts",
    expected: false,
  },
  {
    id: "offsite",
    group: "offsite",
    label: "Offsite copy",
    slug: "dashboard",
    file: "dashboard-backup.env",
    variables: [
      { name: "BACKUP_S3_ENDPOINT", label: "Endpoint", required: true },
      { name: "BACKUP_S3_BUCKET", label: "Bucket", required: true },
      { name: "BACKUP_S3_ACCESS_KEY_ID", label: "Access key ID", required: true },
      { name: "BACKUP_S3_SECRET_ACCESS_KEY", label: "Secret access key", required: true },
      { name: "BACKUP_ENCRYPTION_PASSPHRASE", label: "Passphrase", required: true },
      { name: "BACKUP_S3_REGION", label: "Region", required: false },
      { name: "BACKUP_S3_PREFIX", label: "Prefix", required: false },
    ],
    reader: BACKUP_CADENCE.reader,
    applies: noRestart(BACKUP_CADENCE, "add"),
    hint: "applies within the hour",
    expected: false,
  },
]

export function settingById(id: SettingId): MachineSetting {
  return SETTINGS.find((setting) => setting.id === id)!
}

/** The settings of a group, in the catalogue's order. */
export function settingsOf(group: SettingGroup): MachineSetting[] {
  return SETTINGS.filter((setting) => setting.group === group)
}

/** The setting a variable of a platform file belongs to, null for a variable no setting names. */
export function settingOfVariable(slug: string, file: string, variable: string): MachineSetting | null {
  return SETTINGS.find((setting) => setting.slug === slug && setting.file === file && setting.variables.some((one) => one.name === variable)) ?? null
}

/**
 * What a change to a file ends on when no restart applies it, or null when one
 * does. For a file this catalogue does not know, that nothing applies it by
 * itself: a page never promises what it cannot name.
 */
export function unrestartedSentence(slug: string, file: string, change: FileChange): string | null {
  if (appliesOnRestart(slug, file)) return null
  const setting = SETTINGS.find((one) => one.slug === slug && one.file === file)
  if (setting === undefined) return "No restart applies it."
  return noRestart(cadenceOf(setting), change)
}

function cadenceOf(setting: MachineSetting): Cadence {
  return setting.group === "offsite" ? BACKUP_CADENCE : MONITOR_CADENCE
}

/**
 * The Secrets intro's sentence on when a change applies, for a project and the
 * platform files it lists (none for a project with a store, which reads them
 * all when it starts). The dashboard lists files read at their own pace beside
 * its own, and says so.
 */
export function readingSentence(slug: string, files: readonly string[]): string {
  const restart = files.filter((file) => appliesOnRestart(slug, file))
  const others = files.filter((file) => !appliesOnRestart(slug, file))
  if (others.length === 0) return `${slug} reads these when it starts: a change applies after a restart.`
  const readers = [
    ...new Set(
      others.flatMap((file) => {
        const setting = SETTINGS.find((one) => one.slug === slug && one.file === file)
        return setting === undefined ? [] : [setting.reader]
      }),
    ),
  ]
  const second =
    readers.length === 0
      ? "A restart does not apply the other files."
      : `The other files are read by ${readers.join(" and ")}, each on its own schedule: nothing to restart.`
  if (restart.length === 0) return second
  return `${slug} reads ${restart.join(" and ")} when it starts: a change applies after a restart. ${second}`
}

// --- What the monitor accepts --------------------------------------------------

/** The body formats the monitor's webhook speaks (`WebhookFormat` in monitor/src/notify.ts). */
export type WebhookFormat = "slack" | "discord" | "googlechat" | "text" | "json"

/** In the monitor's order, with the words a Format choice shows. */
export const WEBHOOK_FORMATS: readonly { value: WebhookFormat; label: string }[] = [
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "googlechat", label: "Google Chat" },
  { value: "text", label: "Plain text (ntfy)" },
  { value: "json", label: "JSON" },
]

/**
 * Why the monitor would refuse an alerting address (`alertUrl` in
 * monitor/src/notify.ts), in the page's words, or null when it takes it.
 * Nothing typed is no problem: the setting is simply unset. Both addresses are
 * secrets, and the monitor takes https alone.
 */
export function alertAddressProblem(raw: string): string | null {
  const value = raw.trim()
  if (value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "That isn't an address. Start it with https://."
  }
  if (url.protocol === "https:") return null
  if (url.protocol === "http:") return "Use an https:// address: the monitor refuses plain http."
  return "Use an https:// address: the monitor refuses any other kind."
}

/**
 * The format the monitor picks from the address alone, when
 * `ALERT_WEBHOOK_FORMAT` is unset (`detectedFormat` in monitor/src/notify.ts):
 * Slack's, Discord's, Google Chat's and ntfy.sh's own hosts, `json` for
 * anything else, a self-hosted ntfy or Mattermost, or an address it refuses.
 */
export function detectedWebhookFormat(raw: string): WebhookFormat {
  if (raw.trim() === "" || alertAddressProblem(raw) !== null) return "json"
  const host = new URL(raw.trim()).hostname
  const under = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  if (host === "hooks.slack.com") return "slack"
  if (under("discord.com") || under("discordapp.com")) return "discord"
  if (host === "chat.googleapis.com") return "googlechat"
  if (host === "ntfy.sh") return "text"
  return "json"
}

/**
 * A word on a heartbeat address the monitor accepts and that is nonetheless
 * the wrong one: the address of the check's page in the outside service, not
 * its ping URL. Not a rule of the monitor, which would ping the page.
 */
export function heartbeatPageHint(raw: string): string | null {
  if (raw.trim() === "" || alertAddressProblem(raw) !== null) return null
  const url = new URL(raw.trim())
  if (!url.pathname.startsWith("/checks/")) return null
  return url.hostname === "healthchecks.io"
    ? "This is the check's page. Copy its ping URL instead, https://hc-ping.com/…"
    : "This looks like the check's page. Copy its ping URL instead."
}

/** A word on a webhook address the monitor accepts: ntfy.sh topics are readable by whoever knows the name. */
export function webhookAddressHint(raw: string): string | null {
  if (raw.trim() === "" || alertAddressProblem(raw) !== null) return null
  return new URL(raw.trim()).hostname === "ntfy.sh" ? "ntfy.sh topics are public: pick a topic nobody would guess." : null
}

// --- The state of a setting ----------------------------------------------------

/**
 * What the page knows of a setting's variables:
 *
 * - `unknown`: the secrets are not loaded, or the steward lists no such project;
 * - `no-file`: the file is not on the server, and the owner creates it by hand
 *   (the dashboard never does) for the monitor's and the backups', or the
 *   steward says it is missing for the project's own;
 * - `unmanaged`: the file is there but the steward does not rewrite it, so
 *   nothing can be changed from the page;
 * - `not-set`: the file carries none of the setting's variables;
 * - `incomplete`: it carries some, and not every required one;
 * - `set`: it carries every required one.
 */
export type Presence = "unknown" | "no-file" | "unmanaged" | "not-set" | "incomplete" | "set"

/**
 * What the monitor says of a channel whose address is set, in its own words,
 * for the heartbeat and the webhook alone:
 *
 * - `ok`: the last attempt went through;
 * - `idle`: the webhook is set and the last pass had nothing to say;
 * - `failed`: the last attempt did not go through;
 * - `waiting`: the address is in the file and the monitor has not taken it up,
 *   because it has not passed since, or because it refuses it (its Issues name
 *   a refusal);
 * - `unknown`: the monitor says nothing now, which is not that it works.
 */
export type Channel = "ok" | "idle" | "failed" | "waiting" | "unknown"

export type SettingState = {
  id: SettingId
  presence: Presence
  /** The setting's variables the file carries, in the catalogue's order. */
  present: string[]
  /** The required ones it lacks, for `incomplete`. */
  missing: string[]
  /**
   * When the file last changed. The steward keeps one date per file, shared by
   * every setting it holds: the heartbeat and the format share one.
   */
  changedAt: number | null
  /** A change waits for a restart of the project's service: only ever for `<slug>.env`. */
  restartPending: boolean
  /** The monitor's word on the channel, once the address is set; null for a setting that is no channel. */
  channel: Channel | null
  /** Notices the webhook has not taken, for the webhook once its address is set. */
  undelivered: number
  /** A tone and a word that say it in one place, the same on every page. Empty for `unknown`. */
  tone: Tone
  label: string
}

/** The labels the server gives the monitor's channels in the Issues (`monitorDiscrepancies` in src/monitor.ts). */
export const HEARTBEAT_FAILED_LABEL = "Heartbeat failed"
export const ALERTS_UNDELIVERED_LABEL = "Alerts undelivered"

function channelOf(
  id: SettingId,
  set: boolean,
  discrepancies: readonly Discrepancy[],
  alerting: Alerting | null | undefined,
): { channel: Channel | null; undelivered: number } {
  if (id !== "heartbeat" && id !== "webhook") return { channel: null, undelivered: 0 }
  if (!set) return { channel: null, undelivered: 0 }
  const heartbeat = id === "heartbeat"
  if (alerting === null || alerting === undefined) {
    // A server from before the field, or a monitor that says nothing now: only its Issues can say a channel failed.
    const label = heartbeat ? HEARTBEAT_FAILED_LABEL : ALERTS_UNDELIVERED_LABEL
    return { channel: discrepancies.some((one) => one.slug === null && one.label === label) ? "failed" : "unknown", undelivered: 0 }
  }
  const undelivered = heartbeat ? 0 : alerting.undelivered
  const word = heartbeat ? alerting.heartbeat : alerting.webhook
  if (word === "unconfigured") return { channel: "waiting", undelivered }
  return { channel: word, undelivered }
}

function presenceOf(setting: MachineSetting, project: ProjectView | null | undefined): { presence: Presence; present: string[]; missing: string[]; changedAt: number | null; restartPending: boolean } {
  const file = project?.files.find((one) => one.name === setting.file)
  const none = { present: [], missing: [], changedAt: null, restartPending: false }
  if (project === null || project === undefined) return { presence: "unknown", ...none }
  if (file === undefined || file.state === "absent") return { presence: "no-file", ...none }
  const changedAt = file.modifiedAt
  if (file.state === "unmanaged") return { presence: "unmanaged", ...none, changedAt }
  const present = setting.variables.filter((one) => file.variables.includes(one.name)).map((one) => one.name)
  const missing = setting.variables.filter((one) => one.required && !file.variables.includes(one.name)).map((one) => one.name)
  const restartPending = file.restartPending && appliesOnRestart(setting.slug, setting.file)
  if (present.length === 0) return { presence: "not-set", present, missing, changedAt, restartPending }
  return { presence: missing.length === 0 ? "set" : "incomplete", present, missing, changedAt, restartPending }
}

function wordsOf(setting: MachineSetting, presence: Presence, restartPending: boolean, channel: Channel | null): { tone: Tone; label: string } {
  switch (presence) {
    case "unknown":
      return { tone: "neutral", label: "" }
    case "no-file":
      // The project's own file is always listed, and the Files list calls it missing in red; the others are created by hand.
      return { tone: appliesOnRestart(setting.slug, setting.file) ? "error" : "attention", label: "File missing" }
    case "unmanaged":
      return { tone: "attention", label: "Unmanaged" }
    case "not-set":
      return { tone: setting.expected ? "attention" : "neutral", label: "Not set" }
    case "incomplete":
      return { tone: "attention", label: "Incomplete" }
    case "set":
      if (channel === "failed") return { tone: "error", label: "Failed" }
      if (restartPending) return { tone: "attention", label: PENDING_LABEL }
      if (channel === "waiting") return { tone: "neutral", label: "Waiting" }
      return { tone: "neutral", label: "Set" }
  }
}

/**
 * Where every setting stands: its variables, its file, and for the heartbeat
 * and the webhook what the monitor says of them. `projects` is the steward's
 * listing (null while it loads), `discrepancies` the snapshot's, which stand in
 * for `alerting` on a server from before that field existed, and `alerting` the
 * snapshot's field (null when the monitor says nothing now). The owner's only:
 * a person's listing holds no platform project, so all of it reads `unknown`.
 */
export function settingState(
  projects: readonly ProjectView[] | null,
  discrepancies: readonly Discrepancy[],
  alerting: Alerting | null | undefined,
): Record<SettingId, SettingState> {
  const states = {} as Record<SettingId, SettingState>
  for (const setting of SETTINGS) {
    const project = projects === null ? null : (projects.find((one) => one.slug === setting.slug) ?? null)
    const found = presenceOf(setting, project)
    const { channel, undelivered } = channelOf(setting.id, found.presence === "set", discrepancies, alerting)
    states[setting.id] = { id: setting.id, ...found, channel, undelivered, ...wordsOf(setting, found.presence, found.restartPending, channel) }
  }
  return states
}
