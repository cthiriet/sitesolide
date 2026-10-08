import { describe, expect, test } from "bun:test"
import {
  RESTORE_SCALE_MS,
  STALE_SNAPSHOT_MS,
  auditLine,
  checkReading,
  freshness,
  kindLabel,
  offsiteReading,
  restoreOutcome,
  restoreOver,
  restoreProgress,
  restoreSteps,
  retentionText,
  snapshotSize,
  whereLabel,
} from "../src/lib/backups"
import { SECTIONS, pageFromUrl, siteUrl } from "../src/lib/pages"
import type { AuditEntry, BackupsView, RestoreView, SnapshotView } from "../src/lib/types"

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
      tone: "error",
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
    ).toEqual({ tone: "error", label: "Last run failed", detail: "not enough disk space" })
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
    expect(offsiteReading({ target: null, error: "BACKUP_S3_BUCKET missing" })).toMatchObject({ tone: "error" })
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

describe("the activity", () => {
  const entry = (partial: Partial<AuditEntry>): AuditEntry => ({ id: 1, at: "2026-10-04T12:00:00.000Z", actor: "owner", action: "backup.restore", target: "cms", detail: null, ...partial })

  test("a restore, its result and who asked", () => {
    expect(auditLine(entry({ detail: { result: "ok", snapshot: "cms-1.tar.gz" } }), "cms")).toMatchObject({ what: "Restore from cms-1.tar.gz", tone: "ok", outcome: "Done", who: "Dashboard" })
    expect(auditLine(entry({ actor: "alice@test-zone.invalid", detail: { result: "failure" } }), "cms")).toMatchObject({ outcome: "Failed", who: "alice@test-zone.invalid" })
    expect(auditLine(entry({ detail: { result: "rejects" } }), "cms")).toMatchObject({ tone: "neutral", outcome: "Refused" })
  })

  test("a run fails for this site, or as a whole; another site's failure is not this one's", () => {
    const run = (detail: Record<string, unknown>) => auditLine(entry({ actor: "system", action: "backup.run", target: null, detail }), "cms")
    expect(run({ ok: true, failed: [] })).toMatchObject({ what: "Scheduled run", outcome: "Done", who: "Timer" })
    expect(run({ ok: false, failed: ["shop"] })).toMatchObject({ tone: "ok", outcome: "Done" })
    expect(run({ ok: false, failed: ["cms"] })).toMatchObject({ tone: "error", outcome: "Failed for this site" })
    expect(run({ ok: false, failed: [], error: "the run failed" })).toMatchObject({ tone: "error", outcome: "Failed" })
  })
})
