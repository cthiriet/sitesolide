import { describe, expect, test } from "bun:test"
import {
  RESTORE_SCALE_MS,
  STALE_SNAPSHOT_MS,
  addedText,
  backupStatus,
  checkReading,
  clockTime,
  freshness,
  kindLabel,
  offsiteReading,
  restoreOutcome,
  restoreOver,
  restoreProgress,
  restoreAct,
  restoreSteps,
  retentionText,
  snapshotDay,
  snapshotMoment,
  snapshotSize,
  snapshotsByDay,
  takenLabel,
  whereLabel,
} from "../src/lib/backups"
import { SECTIONS, pageFromUrl, siteUrl } from "../src/lib/pages"
import type { BackupsView, RestoreView, SnapshotView } from "../src/lib/types"

const NOW = Date.UTC(2026, 9, 4, 13, 0, 0)

function snapshot(partial: Partial<SnapshotView> = {}): SnapshotView {
  return { name: "cms-20261004T120000Z.tar", takenAt: NOW - 3_600_000, kind: "scheduled", bytes: 2048, added: 512, local: true, offsite: false, ...partial }
}

function view(partial: Partial<BackupsView> = {}): Pick<BackupsView, "lastRun" | "snapshots" | "excluded"> {
  return { lastRun: null, snapshots: [snapshot()], excluded: null, ...partial }
}

function restore(partial: Partial<RestoreView> = {}): RestoreView {
  return { state: "ok", message: "Restored cms.", snapshot: "cms-20261004T120000Z.tar", preRestore: null, actor: "owner", startedAt: NOW, at: NOW, ...partial }
}

describe("the Backups section's place", () => {
  test("is a site's last section, at its own address", () => {
    expect(SECTIONS.at(-1)).toEqual({ section: "backups", title: "Backups", path: "/site/backups/" })
    expect(siteUrl("cms", "backups")).toBe("/site/backups/?s=cms")
    expect(pageFromUrl("/site/backups/", "?s=cms")).toEqual({ name: "site", slug: "cms", section: "backups" })
  })
})

describe("a snapshot's words", () => {
  test("its size, and what it added when it was taken", () => {
    expect(snapshotSize(snapshot())).toBe("2.0 KB, 512 B new")
    // A steward before restic sends no such figure.
    expect(snapshotSize({ bytes: 2048 })).toBe("2.0 KB")
    expect(snapshotSize({ bytes: 2048, added: null })).toBe("2.0 KB")
  })

  test("its kind and where it lives", () => {
    expect(kindLabel("scheduled")).toBe("Scheduled")
    expect(kindLabel("pre-restore")).toBe("Before restore")
    expect(whereLabel({ local: true, offsite: true })).toBe("Server and offsite")
    expect(whereLabel({ local: true, offsite: false })).toBe("Server")
    expect(whereLabel({ local: false, offsite: true })).toBe("Offsite only")
  })
})

describe("the repositories' checks", () => {
  const at = NOW - 5 * 3_600_000

  test("verified, with what the server's copy takes", () => {
    expect(checkReading({ local: { at, ok: true, error: null }, offsite: null }, { bytes: 3 * 1024 * 1024, at }, NOW)).toEqual({
      tone: "ok",
      label: "Verified 5h ago",
      detail: "All sites' snapshots take 3.0 MB on this server.",
    })
  })

  test("a failed check first, the server's or the bucket's, in its own words", () => {
    expect(checkReading({ local: { at, ok: true, error: null }, offsite: { at, ok: false, error: "the check of the bucket's repository found errors" } }, null, NOW)).toEqual({
      tone: "attention",
      label: "Offsite copy failed its check",
      detail: "the check of the bucket's repository found errors",
    })
    expect(checkReading({ local: { at, ok: false, error: "x" }, offsite: null }, null, NOW).label).toBe("Server's copy failed its check")
  })

  test("not checked yet, or a steward before restic", () => {
    expect(checkReading({ local: null, offsite: null }, null, NOW)).toMatchObject({ tone: "neutral", label: "Not checked yet" })
    expect(checkReading(undefined, undefined, NOW)).toMatchObject({ tone: "neutral", label: "Not checked yet" })
  })
})

describe("the schedule", () => {
  test("the policy in words, zero counts left out", () => {
    expect(retentionText({ hourly: 24, daily: 7, weekly: 4, preRestore: 3 })).toBe("24 hourly, 7 daily, 4 weekly, and the last 3 before a restore")
    expect(retentionText({ hourly: 48, daily: 0, weekly: 0, preRestore: 1 })).toBe("48 hourly, and the last one before a restore")
    expect(retentionText({ hourly: 0, daily: 0, weekly: 0, preRestore: 0 })).toBe("the newest only")
    expect(retentionText(null)).toBe("Not known until the first run")
  })

  test("fresh, stale, failed or never taken", () => {
    expect(freshness(view(), NOW)).toEqual({ tone: "ok", label: "Last snapshot 1h ago", detail: null })
    expect(freshness(view({ snapshots: [snapshot({ takenAt: NOW - STALE_SNAPSHOT_MS - 60_000 })] }), NOW)).toMatchObject({
      tone: "attention",
      label: "No snapshot for 2h",
      // The binary's command, not a script of a checkout: setup starts a stopped timer again.
      detail: expect.stringContaining("sitesolide setup"),
    })
    expect(
      freshness(view({ lastRun: { startedAt: NOW, finishedAt: NOW, ok: false, snapshot: null, error: "not enough disk space" } }), NOW),
    ).toEqual({ tone: "attention", label: "Last run failed", detail: "not enough disk space" })
    expect(freshness(view({ snapshots: [] }), NOW)).toMatchObject({ tone: "neutral", label: "No snapshot yet" })
    expect(freshness(view({ snapshots: [], excluded: "opted out by its sitesolide.json" }), NOW)).toEqual({
      tone: "neutral",
      label: "Not backed up",
      detail: "Opted out by its sitesolide.json",
    })
  })

  test("a before-restore snapshot says nothing of the timer", () => {
    const pre = snapshot({ kind: "pre-restore", takenAt: NOW - 60_000 })
    const old = snapshot({ takenAt: NOW - STALE_SNAPSHOT_MS - 60_000 })
    expect(freshness(view({ snapshots: [pre, old] }), NOW).tone).toBe("attention")
  })

  test("a site left out is not stale: it is not owed a snapshot", () => {
    const old = snapshot({ takenAt: NOW - 30 * 24 * 3_600_000 })
    expect(freshness(view({ snapshots: [old], excluded: "opted out by its sitesolide.json" }), NOW).tone).toBe("ok")
  })

  test("the offsite copy: off, on with where, or misconfigured", () => {
    expect(offsiteReading({ target: null, error: null })).toMatchObject({ tone: "neutral", label: "Off" })
    expect(offsiteReading({ target: "backups at fsn1.example.invalid", error: null })).toEqual({ tone: "ok", label: "Encrypted, every run", detail: "backups at fsn1.example.invalid" })
    expect(offsiteReading({ target: null, error: "BACKUP_S3_BUCKET missing" })).toMatchObject({ tone: "attention" })
  })
})

describe("the restore", () => {
  test("says what the server does, in order, before the confirmation", () => {
    const steps = restoreSteps("cms")
    expect(steps[0]).toContain("as cms's own account")
    expect(steps.findIndex((step) => step.startsWith("Stops"))).toBeLessThan(steps.findIndex((step) => step.startsWith("Saves")))
    expect(steps.at(-1)).toContain("watches it for eight seconds")
  })

  test("is over once the steward stops saying it runs", () => {
    expect(restoreOver(null)).toBe(true)
    expect(restoreOver(restore({ state: "running" }))).toBe(false)
    expect(restoreOver(restore({ state: "failure" }))).toBe(true)
  })

  test("its outcome in words, refusals saying nothing changed", () => {
    expect(restoreOutcome(restore(), "cms")).toMatchObject({ tone: "ok", title: "Restored cms" })
    expect(restoreOutcome(restore({ state: "rejects", message: "no restore request" }), "cms")).toEqual({
      tone: "error",
      title: "Restore refused, nothing changed",
      detail: "No restore request",
    })
    expect(restoreOutcome(restore({ state: "failure", message: "cms did not start" }), "cms")).toMatchObject({ title: "Restore failed", detail: "cms did not start" })
    expect(restoreOutcome(restore({ state: "unknown", message: "unreadable" }), "cms").tone).toBe("attention")
  })

  test("the wait, on a scale of five minutes, never an invented progress", () => {
    expect(restoreProgress(-5)).toEqual({ part: 0, elapsed: "0s", slow: false })
    expect(restoreProgress(65_000)).toMatchObject({ elapsed: "1m 05s", slow: false })
    expect(restoreProgress(RESTORE_SCALE_MS + 1)).toMatchObject({ part: 1, slow: true })
  })
})

describe("the status row", () => {
  type StatusView = Parameters<typeof backupStatus>[0]
  const checked = { local: { at: NOW - 5 * 3_600_000, ok: true, error: null }, offsite: null }
  const status = (partial: Partial<StatusView> = {}) =>
    backupStatus({ lastRun: null, snapshots: [snapshot()], excluded: null, offsite: { target: "backups at fsn1.test-zone.invalid", error: null }, checks: checked, repository: null, ...partial }, NOW)

  test("fine: the last snapshot's age, then short muted facts, and no detail", () => {
    expect(status()).toEqual({
      tone: "ok",
      label: "Last snapshot 1h ago",
      detail: null,
      facts: [
        { text: "Hourly", tone: "neutral" },
        { text: "Offsite copy", tone: "neutral" },
        { text: "Verified 5h ago", tone: "neutral" },
      ],
    })
  })

  test("a warning on a failed run, as the home page's banner says it, keeping the age of the snapshot before it", () => {
    const failed = status({ lastRun: { startedAt: NOW, finishedAt: NOW, ok: false, snapshot: null, error: "not enough disk space" } })
    expect(failed).toMatchObject({ tone: "attention", label: "Last run failed", detail: "not enough disk space" })
    expect(failed.facts[0]).toEqual({ text: "Last snapshot 1h ago", tone: "neutral" })
  })

  test("attention past two hours, with what restarts the timer", () => {
    const stale = status({ snapshots: [snapshot({ takenAt: NOW - STALE_SNAPSHOT_MS - 60_000 })] })
    expect(stale.tone).toBe("attention")
    expect(stale.detail).toContain("sitesolide setup")
  })

  test("a misconfigured bucket or a failed check is the same warning, said in its fact", () => {
    const bucket = status({ offsite: { target: null, error: "BACKUP_S3_BUCKET missing" } })
    expect(bucket.tone).toBe("attention")
    expect(bucket.facts).toContainEqual({ text: "Offsite copy misconfigured", tone: "attention" })
    const check = status({ checks: { local: { at: NOW, ok: false, error: "x" }, offsite: null } })
    expect(check).toMatchObject({ tone: "attention", label: "Last snapshot 1h ago" })
    expect(check.facts).toContainEqual({ text: "Server's copy failed its check", tone: "attention" })
  })

  test("no offsite copy, or nothing checked yet, is information and no alarm", () => {
    const quiet = status({ offsite: { target: null, error: null }, checks: { local: null, offsite: null } })
    expect(quiet.tone).toBe("neutral")
    expect(quiet.facts.map((fact) => fact.text)).toEqual(["Hourly", "No offsite copy", "Not checked yet"])
  })

  test("a site left out says why rather than a schedule it does not follow", () => {
    const out = status({ excluded: "opted out by its sitesolide.json" })
    expect(out.facts[0]).toEqual({ text: "No longer backed up: opted out by its sitesolide.json", tone: "neutral" })
    expect(out.facts.map((fact) => fact.text)).not.toContain("Hourly")
  })
})

describe("when a snapshot was taken", () => {
  // 13:00 UTC on October 4th: 15:00 in Paris, the same day.
  const zone = "Europe/Paris"
  const hour = 3_600_000

  test("today and yesterday by name, older days by their date", () => {
    expect(snapshotDay(NOW - hour, NOW, zone)).toBe("Today")
    expect(snapshotDay(NOW - 20 * hour, NOW, zone)).toBe("Yesterday")
    expect(snapshotDay(NOW - 3 * 24 * hour, NOW, zone)).toBe("Thu, Oct 1")
  })

  test("in a row, the day and the time; in a sentence and on the button, the date and the time", () => {
    expect(clockTime(NOW - hour, zone)).toBe("14:00")
    expect(takenLabel(NOW - hour, NOW, zone)).toBe("Today 14:00")
    expect(snapshotMoment(NOW - hour, zone)).toBe("Oct 4, 14:00")
    // The confirmation's button names the act, never a bare "Restore".
    expect(restoreAct("cms", NOW - hour, zone)).toBe("Restore cms to Oct 4, 14:00")
  })

  test("Show all groups them by day, newest first as they come", () => {
    const days = snapshotsByDay([snapshot({ takenAt: NOW - hour }), snapshot({ takenAt: NOW - 2 * hour }), snapshot({ takenAt: NOW - 20 * hour })], NOW, zone)
    expect(days.map((day) => [day.day, day.snapshots.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ])
  })

  test("what a snapshot added, for its size's tooltip, when the steward says it", () => {
    expect(addedText(snapshot())).toBe("512 B new")
    expect(addedText({ added: null })).toBeNull()
    expect(addedText({})).toBeNull()
  })
})
