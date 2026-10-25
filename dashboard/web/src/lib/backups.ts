/**
 * What a site's backups say inside the page, and only that: the words of a
 * snapshot and of its day, of the status row, of a restore, and the wait.
 * Pure.
 *
 * No rule of what may be restored lives here: the steward decides, says why
 * not in `reason`, and the page shows it as it stands. A rule copied into the
 * browser would protect nothing.
 */
import { BACKUP_SEVERITY } from "../../../borrowed/backups"
import { ago, capitalise, duration, size } from "./format"
import { severityTone, type Tone } from "./tones"
import type { BackupsView, CheckView, RestoreView, RetentionPolicy, SnapshotKind, SnapshotView } from "./types"

/** The page reads the backups again this often, and every two seconds while a restore runs. */
export const BACKUPS_REFRESH_MS = 30_000
export const RESTORE_POLL_MS = 2_000

/** A schedule that has not produced a snapshot for this long is worth a look: the timer runs hourly. */
export const STALE_SNAPSHOT_MS = 2 * 60 * 60 * 1000

/** What the steward answers when it predates the backups: it knows no such route. */
export const OUTDATED_STEWARD = "The steward on the server doesn't know backups yet."

export function kindLabel(kind: SnapshotKind): string {
  return kind === "pre-restore" ? "Before restore" : "Scheduled"
}

export function whereLabel(snapshot: Pick<SnapshotView, "local" | "offsite">): string {
  if (snapshot.local && snapshot.offsite) return "Server and offsite"
  return snapshot.local ? "Server" : "Offsite only"
}

/** "24 hourly, 7 daily, 4 weekly, and the last 3 before a restore". Zero counts are left out. */
export function retentionText(policy: RetentionPolicy | null): string {
  if (policy === null) return "Not known until the first run"
  const parts = [
    policy.hourly > 0 ? `${policy.hourly} hourly` : null,
    policy.daily > 0 ? `${policy.daily} daily` : null,
    policy.weekly > 0 ? `${policy.weekly} weekly` : null,
  ].filter((part): part is string => part !== null)
  const calendar = parts.length === 0 ? "the newest only" : parts.join(", ")
  if (policy.preRestore === 0) return calendar
  return `${calendar}, and the last ${policy.preRestore === 1 ? "one" : policy.preRestore} before a restore`
}

export type Reading = { tone: Tone; label: string; detail: string | null }

/**
 * The tone of a backup in trouble, a failed run, a failed check, a bucket
 * misconfigured: the one severity the monitor rates it by and the home
 * page's banner says it in (`BACKUP_SEVERITY` in bin/cli/backups.ts), a
 * warning.
 */
export const BACKUP_TROUBLE: Tone = severityTone(BACKUP_SEVERITY)

/**
 * The state of the schedule for this site, in one line: the last run failed
 * for it, no snapshot for over two hours, both worth a look, or how old the
 * newest one is.
 */
export function freshness(view: Pick<BackupsView, "lastRun" | "snapshots" | "excluded">, serverNow: number): Reading {
  if (view.lastRun !== null && !view.lastRun.ok) {
    return { tone: BACKUP_TROUBLE, label: "Last run failed", detail: view.lastRun.error }
  }
  // The schedule's health is its own snapshots': a before-restore one says nothing of the timer.
  const scheduled = view.snapshots.filter((snapshot) => snapshot.kind === "scheduled")
  const newest = scheduled.find((snapshot) => snapshot.local) ?? scheduled[0] ?? view.snapshots[0]
  if (newest === undefined) {
    return view.excluded === null
      ? { tone: "neutral", label: "No snapshot yet", detail: "The first one comes with the next hourly run." }
      : { tone: "neutral", label: "Not backed up", detail: capitalise(view.excluded) }
  }
  const age = serverNow - newest.takenAt
  if (view.excluded === null && age > STALE_SNAPSHOT_MS) {
    return { tone: "attention", label: `No snapshot for ${duration(age)}`, detail: "The hourly timer may be stopped: sitesolide setup, run again for this server, starts it" }
  }
  return { tone: "ok", label: `Last snapshot ${ago(age)}`, detail: null }
}

export function offsiteReading(offsite: BackupsView["offsite"]): Reading {
  if (offsite.error !== null) return { tone: BACKUP_TROUBLE, label: "Offsite copy misconfigured", detail: offsite.error }
  if (offsite.target === null) return { tone: "neutral", label: "Off", detail: "Snapshots stay on this server only." }
  return { tone: "ok", label: "Encrypted, every run", detail: offsite.target }
}

/**
 * The last daily check of the server's copy and of the bucket's, in one
 * line: a failure first, then how long ago. A steward before restic sends no
 * checks, and the row says nothing worth alarm.
 */
export function checkReading(checks: BackupsView["checks"], repository: BackupsView["repository"], serverNow: number): Reading {
  const local: CheckView | null = checks?.local ?? null
  const offsite: CheckView | null = checks?.offsite ?? null
  const failed = [local, offsite].find((check) => check !== null && !check.ok)
  if (failed !== undefined && failed !== null) {
    return { tone: BACKUP_TROUBLE, label: failed === local ? "Server's copy failed its check" : "Offsite copy failed its check", detail: failed.error }
  }
  if (local === null) return { tone: "neutral", label: "Not checked yet", detail: "A part of every copy is read back once a day, starting a day after the first snapshot." }
  const stored = repository === null || repository === undefined ? null : `All sites' snapshots take ${size(repository.bytes)} on this server.`
  return { tone: "ok", label: `Verified ${ago(serverNow - local.at)}`, detail: stored }
}

/** A snapshot's size, and what it added when it was taken, when known: "12 MB, 340 KB new". */
export function snapshotSize(snapshot: Pick<SnapshotView, "bytes" | "added">): string {
  return snapshot.added === undefined || snapshot.added === null ? size(snapshot.bytes) : `${size(snapshot.bytes)}, ${size(snapshot.added)} new`
}

/** What a snapshot added to the repository when it was taken, for its size's tooltip: "23 KB new"; null when unknown. */
export function addedText(snapshot: Pick<SnapshotView, "added">): string | null {
  return snapshot.added === undefined || snapshot.added === null ? null : `${size(snapshot.added)} new`
}

// --- The status row --------------------------------------------------------------------

export type StatusFact = { text: string; tone: Tone }

/**
 * The site's backups in one row: the freshness of its last snapshot first,
 * in its tone, the detail of a failure or a stale timer under it, then the
 * schedule, the offsite copy and the last check as short facts, each in its
 * tone when it is wrong. `tone` is the worst of the three: a failed run, a
 * misconfigured bucket, a failed check or a stale timer, each worth a look
 * (`BACKUP_TROUBLE`). A fine row says it in muted words, with no dot.
 */
export type BackupStatus = { tone: Tone; label: string; detail: string | null; facts: StatusFact[] }

const WORST: Readonly<Record<Tone, number>> = { error: 3, attention: 2, neutral: 1, ok: 0 }

export function backupStatus(
  view: Pick<BackupsView, "lastRun" | "snapshots" | "excluded" | "offsite" | "checks" | "repository">,
  serverNow: number,
): BackupStatus {
  const fresh = freshness(view, serverNow)
  const offsite = offsiteReading(view.offsite)
  const check = checkReading(view.checks, view.repository, serverNow)
  const facts: StatusFact[] = []
  // A failed run leaves the snapshot before it, which is what a restore would bring back.
  const newest = view.snapshots.find((snapshot) => snapshot.kind === "scheduled")
  const failed = view.lastRun !== null && !view.lastRun.ok
  if (failed && newest !== undefined) facts.push({ text: `Last snapshot ${ago(serverNow - newest.takenAt)}`, tone: "neutral" })
  // A site left out is owed no snapshot: it says why rather than a schedule it does not follow.
  if (view.excluded === null) facts.push({ text: "Hourly", tone: "neutral" })
  else if (fresh.tone === "ok") facts.push({ text: `No longer backed up: ${view.excluded}`, tone: "neutral" })
  facts.push(
    offsite.tone === BACKUP_TROUBLE
      ? { text: offsite.label, tone: BACKUP_TROUBLE }
      : { text: offsite.tone === "neutral" ? "No offsite copy" : "Offsite copy", tone: "neutral" },
  )
  facts.push(check.tone === BACKUP_TROUBLE ? { text: check.label, tone: BACKUP_TROUBLE } : { text: check.label, tone: "neutral" })
  const tone = [fresh.tone, offsite.tone, check.tone].reduce((worst, one) => (WORST[one] > WORST[worst] ? one : worst), "ok" as Tone)
  return { tone, label: fresh.label, detail: fresh.tone === "ok" ? null : fresh.detail, facts }
}

// --- When a snapshot was taken ------------------------------------------------------------

const DAY_MS = 24 * 3_600_000

/** The calendar day of a moment, in the browser's zone or `timeZone`: "2026-10-25", to compare two moments. */
function dayKey(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

/** "19:02", in the browser's zone or `timeZone`. Assembled from its parts, as `dateTime` is, so that every engine writes the same. */
export function clockTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  return `${value("hour")}:${value("minute")}`
}

/** A snapshot's day, as a heading: "Today", "Yesterday", then "Thu, Oct 23". */
export function snapshotDay(ms: number, serverNow: number, timeZone?: string): string {
  const key = dayKey(ms, timeZone)
  if (key === dayKey(serverNow, timeZone)) return "Today"
  if (key === dayKey(serverNow - DAY_MS, timeZone)) return "Yesterday"
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  return `${value("weekday")}, ${value("month")} ${value("day")}`
}

/** When a snapshot was taken, in a row: "Today 19:02", "Yesterday 23:02", "Thu, Oct 23 02:02". */
export function takenLabel(ms: number, serverNow: number, timeZone?: string): string {
  return `${snapshotDay(ms, serverNow, timeZone)} ${clockTime(ms, timeZone)}`
}

/** A snapshot's day and time in a sentence, without the zone: "Oct 25, 19:02". */
export function snapshotMoment(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? ""
  return `${value("month")} ${value("day")}, ${clockTime(ms, timeZone)}`
}

/**
 * What a restore's button says it does, the snapshot named by its day and
 * time: "Restore cms to Oct 25, 19:02". The zone is the browser's, as in
 * every time the page shows; the dialog's title names it.
 */
export function restoreAct(slug: string, ms: number, timeZone?: string): string {
  return `Restore ${slug} to ${snapshotMoment(ms, timeZone)}`
}

export type SnapshotDay = { day: string; snapshots: SnapshotView[] }

/** The snapshots under the day they were taken, newest first as they come: the list once *Show all* is open. */
export function snapshotsByDay(snapshots: readonly SnapshotView[], serverNow: number, timeZone?: string): SnapshotDay[] {
  const days: SnapshotDay[] = []
  for (const snapshot of snapshots) {
    const day = snapshotDay(snapshot.takenAt, serverNow, timeZone)
    const last = days.at(-1)
    if (last !== undefined && last.day === day) last.snapshots.push(snapshot)
    else days.push({ day, snapshots: [snapshot] })
  }
  return days
}

/** What the server does, in the order it does it: the dialog lists it before the confirmation. */
export function restoreSteps(slug: string): string[] {
  return [
    `Extracts the snapshot beside the current data, as ${slug}'s own account.`,
    `Stops ${slug}.`,
    "Saves the current data as a before-restore snapshot.",
    "Puts the snapshot in place of the data folder.",
    `Starts ${slug} and watches it for eight seconds.`,
  ]
}

/** Is the restore over? */
export function restoreOver(restore: RestoreView | null): boolean {
  return restore === null || restore.state !== "running"
}

export type RestoreOutcome = { tone: Tone; title: string; detail: string }

export function restoreOutcome(restore: RestoreView, slug: string): RestoreOutcome {
  // The steward's reasons start in lowercase, a sentence the page begins; one
  // that starts with the slug keeps it as it is written, a slug has no capital.
  const sentence = restore.message.startsWith(slug) ? restore.message : capitalise(restore.message)
  switch (restore.state) {
    case "ok":
      return { tone: "ok", title: `Restored ${slug}`, detail: restore.message }
    case "rejects":
      return { tone: "error", title: "Restore refused, nothing changed", detail: sentence }
    case "failure":
      return { tone: "error", title: "Restore failed", detail: sentence }
    case "unknown":
      return { tone: "attention", title: "Restore result unknown", detail: sentence }
    case "running":
      return { tone: "neutral", title: `Restoring ${slug}`, detail: restore.message }
  }
}

/** The wait, on a scale of five minutes: a restore of a large site can take that long. */
export const RESTORE_SCALE_MS = 5 * 60 * 1000

export function restoreProgress(elapsedMs: number): { part: number; elapsed: string; slow: boolean } {
  const bounded = Math.max(0, elapsedMs)
  const seconds = Math.floor(bounded / 1000)
  return {
    part: Math.min(1, bounded / RESTORE_SCALE_MS),
    elapsed: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`,
    slow: bounded >= RESTORE_SCALE_MS,
  }
}
