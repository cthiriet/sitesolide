/**
 * What a site's backups say inside the page, and only that: the words of a
 * snapshot, of the schedule, of a restore and of its activity, and the wait.
 * Pure.
 *
 * No rule of what may be restored lives here: the steward decides, says why
 * not in `reason`, and the page shows it as it stands. A rule copied into the
 * browser would protect nothing.
 */
import { ago, dateTime, duration, size } from "./format"
import type { Tone } from "./tones"
import type { BackupAuditEntry, BackupsView, CheckView, RestoreView, RetentionPolicy, SnapshotKind, SnapshotView } from "./types"

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
 * The state of the schedule for this site, in one line: the last run failed
 * for it (error), no snapshot for over two hours (attention), or how old the
 * newest one is.
 */
export function freshness(view: Pick<BackupsView, "lastRun" | "snapshots" | "excluded">, serverNow: number): Reading {
  if (view.lastRun !== null && !view.lastRun.ok) {
    return { tone: "error", label: "Last run failed", detail: view.lastRun.error }
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
  if (offsite.error !== null) return { tone: "error", label: "Offsite copy misconfigured", detail: offsite.error }
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
    return { tone: "error", label: failed === local ? "Server's copy failed its check" : "Offsite copy failed its check", detail: failed.error }
  }
  if (local === null) return { tone: "neutral", label: "Not checked yet", detail: "A part of every copy is read back once a day, starting a day after the first snapshot." }
  const stored = repository === null || repository === undefined ? null : `All sites' snapshots take ${size(repository.bytes)} on this server.`
  return { tone: "ok", label: `Verified ${ago(serverNow - local.at)}`, detail: stored }
}

/** A snapshot's size, and what it added when it was taken, when known: "12 MB, 340 KB new". */
export function snapshotSize(snapshot: Pick<SnapshotView, "bytes" | "added">): string {
  return snapshot.added === undefined || snapshot.added === null ? size(snapshot.bytes) : `${size(snapshot.bytes)}, ${size(snapshot.added)} new`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A snapshot's time as the page names it: the browser's time zone, the time of day. */
export function snapshotTime(takenAt: number, timeZone?: string): string {
  return dateTime(takenAt, timeZone)
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

export type AuditLine = { what: string; tone: Tone; outcome: string | null; who: string; at: number }

function detailText(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key]
  return typeof value === "string" ? value : null
}

/** An audit entry in words: what was done, how it ended, who did it. Never a value: the audit holds none. */
export function auditLine(entry: BackupAuditEntry, slug: string): AuditLine {
  const at = Date.parse(entry.at)
  const who = entry.actor === "system" ? "Timer" : entry.actor === "owner" ? "Dashboard" : entry.actor
  if (entry.action === "backup.restore") {
    const result = detailText(entry.detail, "result")
    const snapshot = detailText(entry.detail, "snapshot")
    return {
      what: snapshot === null ? "Restore" : `Restore from ${snapshot}`,
      tone: result === "ok" ? "ok" : result === "rejects" ? "neutral" : "error",
      outcome: result === "ok" ? "Done" : result === "rejects" ? "Refused" : "Failed",
      who,
      at,
    }
  }
  if (entry.action === "backup.run") {
    // A run fails for this site, or as a whole; another site's failure is not this one's.
    const failed = Array.isArray(entry.detail?.failed) ? (entry.detail.failed as unknown[]) : []
    const whole = typeof entry.detail?.error === "string"
    if (whole) return { what: "Scheduled run", tone: "error", outcome: "Failed", who, at }
    const mine = failed.includes(slug)
    return { what: "Scheduled run", tone: mine ? "error" : "ok", outcome: mine ? "Failed for this site" : "Done", who, at }
  }
  return { what: entry.action, tone: "neutral", outcome: null, who, at }
}
