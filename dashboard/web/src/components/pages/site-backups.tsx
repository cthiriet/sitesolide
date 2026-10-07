import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { ArchiveRestore, CircleCheck, CircleX, CloudOff, DatabaseBackup, History, Info, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Command, useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { Banner, EmptyState, ErrorState, INPUT_DIALOG, Panel, PanelSkeleton, RowsSkeleton, Status } from "@/components/page"
import { SecretsLockControl } from "@/components/secrets"
import { useSecretsActions } from "@/components/secrets-actions"
import { Track } from "@/components/secrets-dialogs"
import { SitePage } from "@/components/site"
import { readBackupAudit, readBackups, restoreBackup } from "@/lib/api"
import { confirmationValid, removalConfirmation } from "@/lib/access"
import {
  BACKUPS_REFRESH_MS,
  OUTDATED_STEWARD,
  RESTORE_POLL_MS,
  auditLine,
  freshness,
  kindLabel,
  offsiteReading,
  restoreOutcome,
  restoreOver,
  restoreProgress,
  restoreSteps,
  retentionText,
  snapshotTime,
  whereLabel,
} from "@/lib/backups"
import { ago, dateTime, size } from "@/lib/format"
import { UNREACHABLE, refusalOf, succeeded } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { BackupAuditEntry, BackupsView, RestoreView, SnapshotView } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * A site's backups: when its data folder was last saved, what is kept and
 * where, every snapshot, and the restore of one of them. The steward reads
 * them as root and decides what may be restored; the page shows its reasons.
 */

type Load =
  | { state: "loading" }
  | { state: "error"; message: string; outdated: boolean }
  | { state: "ready"; view: BackupsView; audit: BackupAuditEntry[] | null }

/**
 * The backups, read on opening, with every snapshot of the machine (every
 * thirty seconds), and every two seconds while a restore runs. A failed read
 * keeps what was there, as everywhere else.
 */
function useBackups(slug: string) {
  const { generation, sessionExpired } = useData()
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [following, setFollowing] = useState(false)

  const reload = useCallback(async () => {
    const [{ status, body }, audit] = await Promise.all([readBackups(slug), readBackupAudit(slug)])
    if (status === 200 && body !== null && typeof body.backups === "object" && body.backups !== null) {
      const entries = audit.status === 200 && audit.body !== null && Array.isArray(audit.body.entries) ? audit.body.entries : null
      setLoad({ state: "ready", view: body.backups, audit: entries })
      return body.backups
    }
    if (status === 401) {
      sessionExpired()
      return null
    }
    const outdated = status === 404 && body?.message === "no such route"
    const refusal = refusalOf(status, body)
    const message = outdated ? OUTDATED_STEWARD : refusal.kind === "unreachable" || refusal.kind === "busy" || refusal.kind === "rejects" ? refusal.message : UNREACHABLE
    setLoad((before) => (before.state === "ready" ? before : { state: "error", message, outdated }))
    return null
  }, [slug, sessionExpired])

  useEffect(() => {
    void reload()
  }, [reload, generation])

  const running = load.state === "ready" && load.view.restore?.state === "running"
  useEffect(() => {
    if (!running && !following) return
    const timer = window.setInterval(() => void reload(), RESTORE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, following, reload])

  // Between two snapshots of the machine, the page still reads a schedule that moves.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload()
    }, BACKUPS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [reload])

  return { load, reload, setFollowing }
}

// --- The schedule --------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" className="w-36 py-2.5 pr-3 pl-4 text-left align-top font-normal text-muted-foreground sm:w-44">
        {label}
      </th>
      <td className="py-2.5 pr-4 pl-3 align-top">{children}</td>
    </tr>
  )
}

function Reading({ reading }: { reading: { tone: "ok" | "attention" | "error" | "neutral"; label: string; detail: string | null } }) {
  return (
    <div className="grid gap-0.5">
      <Status tone={reading.tone} className={cn("whitespace-normal", reading.tone === "neutral" && "text-foreground")}>
        {reading.label}
      </Status>
      {reading.detail !== null && <span className="text-xs text-pretty text-muted-foreground wrap-anywhere">{reading.detail}</span>}
    </div>
  )
}

function SchedulePanel({ view, serverNow }: { view: BackupsView; serverNow: number }) {
  const restore = view.restore
  return (
    <Panel title="Schedule" full>
      <table className="w-full text-sm">
        <caption className="sr-only">How this site's data is saved</caption>
        <tbody className="divide-y divide-divider">
          <Row label="This site">
            <Reading reading={freshness(view, serverNow)} />
          </Row>
          <Row label="Every hour, keeps">{retentionText(view.retention)}</Row>
          <Row label="Offsite copy">
            <Reading reading={offsiteReading(view.offsite)} />
          </Row>
          {restore !== null && restore.state !== "running" && restore.at !== null && (
            <Row label="Last restore">
              <Reading
                reading={{
                  tone: restoreOutcome(restore, view.slug).tone,
                  label: `${restoreOutcome(restore, view.slug).title}, ${ago(serverNow - restore.at)}`,
                  detail: restore.message,
                }}
              />
            </Row>
          )}
        </tbody>
      </table>
    </Panel>
  )
}

// --- The snapshots --------------------------------------------------------------------

function When({ at, serverNow }: { at: number; serverNow: number }) {
  return (
    <span className="grid">
      <time dateTime={new Date(at).toISOString()} className="tabular-nums">
        {snapshotTime(at)}
      </time>
      <span className="text-xs text-muted-foreground">{ago(serverNow - at)}</span>
    </span>
  )
}

function SnapshotsPanel({
  view,
  serverNow,
  onRestore,
}: {
  view: BackupsView
  serverNow: number
  onRestore: (snapshot: SnapshotView) => void
}) {
  // A day and a half of hourly snapshots, then the dailies: the newest are the
  // ones restored, the rest one click away.
  const [all, setAll] = useState(false)
  const shown = all ? view.snapshots : view.snapshots.slice(0, SHOWN_SNAPSHOTS)
  const hidden = view.snapshots.length - shown.length
  const caption = `Snapshots of ${view.slug}, newest first`
  const restoreButton = (snapshot: SnapshotView) => (
    <Button
      variant="outline"
      size="sm"
      disabled={!view.restorable}
      onClick={() => onRestore(snapshot)}
      aria-label={`Restore ${view.slug} from ${snapshotTime(snapshot.takenAt)}`}
      className="max-md:h-10"
    >
      <ArchiveRestore />
      Restore
    </Button>
  )
  return (
    <Panel
      title="Snapshots"
      count={view.snapshots.length}
      description={
        view.restorable ? (
          "Restoring saves the current data first, so it can be undone."
        ) : view.reason === null || view.snapshots.length === 0 ? undefined : (
          <span className="flex gap-1.5">
            <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>
              <span className="sr-only">Why no restore is offered: </span>
              {view.reason.charAt(0).toUpperCase() + view.reason.slice(1)}.
            </span>
          </span>
        )
      }
      full
    >
      {view.snapshots.length === 0 ? (
        <EmptyState icon={DatabaseBackup} title={`No snapshot of ${view.slug} yet`} compact>
          {view.excluded === null
            ? "The first one comes with the next hourly run."
            : `${view.slug} is not backed up: ${view.excluded}.`}
        </EmptyState>
      ) : (
        <div className="@container">
          <table className="hidden w-full text-sm @2xl:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="h-10 border-b bg-muted text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 pl-4 font-medium">
                  Taken
                </th>
                <th scope="col" className="px-3 font-medium">
                  Kind
                </th>
                <th scope="col" className="px-3 text-right font-medium">
                  Size
                </th>
                <th scope="col" className="px-3 font-medium">
                  Where
                </th>
                <th scope="col" className="px-3 pr-4 text-right font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {shown.map((snapshot) => (
                <tr key={snapshot.name}>
                  <td className="px-3 py-3 pl-4">
                    <When at={snapshot.takenAt} serverNow={serverNow} />
                  </td>
                  <td className="px-3 py-3">{kindLabel(snapshot.kind)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{size(snapshot.bytes)}</td>
                  <td className="px-3 py-3">{whereLabel(snapshot)}</td>
                  <td className="px-3 py-3 pr-4 text-right">{restoreButton(snapshot)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ol aria-label={caption} className="divide-y divide-divider @2xl:hidden">
            {shown.map((snapshot) => (
              <li key={snapshot.name} className="flex items-center gap-3 px-4 py-3">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <When at={snapshot.takenAt} serverNow={serverNow} />
                  <span className="text-xs text-muted-foreground">
                    {kindLabel(snapshot.kind)}, {size(snapshot.bytes)}, {whereLabel(snapshot).toLowerCase()}
                  </span>
                </div>
                {restoreButton(snapshot)}
              </li>
            ))}
          </ol>

          {hidden > 0 && (
            <div className="border-t px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => setAll(true)} className="-ml-2 text-muted-foreground hover:text-foreground max-md:h-10">
                Show all {view.snapshots.length} snapshots
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

/** The snapshots listed before "Show all": the last twelve hours cover what is usually restored. */
const SHOWN_SNAPSHOTS = 12

// --- The activity --------------------------------------------------------------------

function ActivityPanel({ slug, audit, serverNow }: { slug: string; audit: BackupAuditEntry[] | null; serverNow: number }) {
  return (
    <Panel title="Activity" description="The scheduled runs and the restores, newest first." full>
      {audit === null && <ErrorState title="Couldn't load the backup activity." compact />}
      {audit !== null && audit.length === 0 && (
        <EmptyState icon={History} title="No activity yet" compact>
          The hourly runs and the restores of {slug} show up here.
        </EmptyState>
      )}
      {audit !== null && audit.length > 0 && (
        <ol aria-label={`Backup activity of ${slug}, most recent first`} className="divide-y divide-divider">
          {audit.slice(0, 20).map((entry) => {
            const line = auditLine(entry, slug)
            return (
              <li key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="text-sm wrap-anywhere">{line.what}</span>
                <time dateTime={entry.at} title={Number.isFinite(line.at) ? dateTime(line.at) : undefined} className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {Number.isFinite(line.at) ? ago(serverNow - line.at) : entry.at}
                </time>
                <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {line.outcome !== null && (
                    <Status tone={line.tone} className={cn(line.tone === "ok" && "text-foreground")}>
                      {line.outcome}
                    </Status>
                  )}
                  <span>{line.who}</span>
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}

// --- The restore -----------------------------------------------------------------------

type Phase = { phase: "confirmation" } | { phase: "in-progress"; start: number } | { phase: "over"; restore: RestoreView }

type Opening = { snapshot: SnapshotView; opening: number; open: boolean }

function RestoreWait({ start, message }: { start: number; message: string }) {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { part, elapsed, slow } = restoreProgress(clock - start)
  return (
    <div className="grid gap-2">
      <Track part={part} elapsed={elapsed} usual={null} finish="5 min" label={message} />
      <p className="text-xs text-pretty text-muted-foreground">
        {slow ? "A large site takes a while. Keep this open: the result always comes." : "Keep this open to see the result."}
      </p>
    </div>
  )
}

function RestoreFlow({
  slug,
  snapshot,
  restore,
  busy,
  onStarted,
  onLocked,
  onOver,
}: {
  slug: string
  snapshot: SnapshotView
  restore: RestoreView | null
  busy: { current: boolean }
  onStarted: () => void
  onLocked: () => void
  onOver: () => void
}) {
  const announce = useAnnounce()
  const { sessionExpired, offset } = useData()
  const [phase, setPhase] = useState<Phase>({ phase: "confirmation" })
  const [entry, setEntry] = useState("")
  const [error, setError] = useState("")
  const inputId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const when = snapshotTime(snapshot.takenAt)

  useEffect(() => {
    busy.current = phase.phase === "in-progress"
    if (phase.phase === "over") closeButton.current?.focus()
  }, [phase, busy])
  useEffect(
    () => () => {
      busy.current = false
    },
    [busy],
  )

  // The page reads the backups every two seconds while waiting: the restore
  // is over once the steward stops saying it runs, with a result from after
  // this request was sent, compared on the server's clock.
  useEffect(() => {
    if (phase.phase !== "in-progress" || restore === null) return
    if (restoreOver(restore) && (restore.startedAt ?? 0) >= phase.start + offset - 5_000) {
      setPhase({ phase: "over", restore })
      const outcome = restoreOutcome(restore, slug)
      announce(`${outcome.title}. ${outcome.detail}`)
      onOver()
    }
  }, [phase, restore, slug, offset, announce, onOver])

  async function confirm(event: SyntheticEvent) {
    event.preventDefault()
    if (phase.phase !== "confirmation") return
    if (!confirmationValid(entry, slug)) {
      setError(`Type ${slug} to confirm.`)
      return
    }
    setError("")
    const start = Date.now()
    setPhase({ phase: "in-progress", start })
    announce(`Restoring ${slug}`)
    const { status, body } = await restoreBackup({ slug, snapshot: snapshot.name, confirmation: removalConfirmation(entry) })
    if (succeeded(status)) return onStarted()
    const refusal = refusalOf(status, body)
    if (refusal.kind === "session") return sessionExpired()
    if (refusal.kind === "locked") return onLocked()
    // Nothing changed on the server: the form stays, with the steward's reason.
    setPhase({ phase: "confirmation" })
    setError(refusal.message)
  }

  if (phase.phase === "over") {
    const outcome = restoreOutcome(phase.restore, slug)
    const Icon = outcome.tone === "ok" ? CircleCheck : outcome.tone === "attention" ? TriangleAlert : CircleX
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[outcome.tone])} />
            {outcome.title}
          </DialogTitle>
          <DialogDescription className="text-pretty">{outcome.detail}</DialogDescription>
        </DialogHeader>
        {outcome.tone === "ok" && phase.restore.preRestore !== null && (
          <p className="text-sm text-pretty text-muted-foreground">
            To undo it, restore the before-restore snapshot now at the top of the list.
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button ref={closeButton} className="max-sm:h-11" />}>Close</DialogClose>
        </DialogFooter>
      </>
    )
  }

  const inProgress = phase.phase === "in-progress"
  return (
    <form noValidate onSubmit={confirm} className="grid gap-5" aria-busy={inProgress || undefined}>
      <DialogHeader>
        <DialogTitle>{inProgress ? `Restoring ${slug}…` : `Restore ${slug} from ${when}?`}</DialogTitle>
        <DialogDescription className="text-pretty">
          {slug} stops, its data folder is replaced by the snapshot of {when}, then it starts again.
        </DialogDescription>
      </DialogHeader>

      {!inProgress && (
        <Banner tone="error">
          <span className="font-medium">What {slug} saved since {when} is set aside.</span> It is kept as a before-restore
          snapshot, which you can restore to undo this.
        </Banner>
      )}

      <div className="grid gap-2">
        <p className="text-sm font-medium">What the server does</p>
        <ol className="grid list-decimal gap-1 pl-5 text-sm marker:text-muted-foreground">
          {restoreSteps(slug).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-xs text-pretty text-muted-foreground">
          If {slug} doesn't come back on the restored data, its previous data is put back and it starts on that.
        </p>
      </div>

      {inProgress && <RestoreWait start={phase.start} message={restore?.state === "running" ? restore.message : "Starting the restore."} />}

      {!inProgress && (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={entry}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setEntry(event.target.value)
              setError("")
            }}
            aria-invalid={error !== "" || undefined}
            className="h-10 font-mono sm:h-9"
          />
          {error !== "" && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        {/* A restore under way cannot be cancelled: the server sees it through, or puts the data back. */}
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button type="submit" variant="destructive" disabled={inProgress || !confirmationValid(entry, slug)} className="max-sm:h-11">
          {inProgress ? "Restoring…" : "Restore"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function RestoreDialog({
  slug,
  opening,
  restore,
  onClose,
  onStarted,
  onLocked,
  onOver,
}: {
  slug: string
  opening: Opening | null
  restore: RestoreView | null
  onClose: () => void
  onStarted: () => void
  onLocked: () => void
  onOver: () => void
}) {
  const busy = useRef(false)
  return (
    <Dialog
      open={opening?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !busy.current) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className={cn("gap-5 sm:max-w-lg", INPUT_DIALOG)}>
        {opening !== null && (
          <RestoreFlow
            key={opening.opening}
            slug={slug}
            snapshot={opening.snapshot}
            restore={restore}
            busy={busy}
            onStarted={onStarted}
            onLocked={onLocked}
            onOver={onOver}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// --- The section -----------------------------------------------------------------------

function Content({ slug, backups, onRestore }: { slug: string; backups: ReturnType<typeof useBackups>; onRestore: (snapshot: SnapshotView) => void }) {
  const { now, offset } = useData()
  const actions = useSecretsActions()
  const serverNow = now + offset
  const { load, reload } = backups
  const [rereading, setRereading] = useState(false)

  async function retry() {
    setRereading(true)
    try {
      await reload()
    } finally {
      setRereading(false)
    }
  }

  if (load.state === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading backups" className="grid gap-6">
        <PanelSkeleton lines={3} />
        <div className="overflow-hidden rounded-xl border bg-card">
          <RowsSkeleton lines={4} />
        </div>
      </div>
    )
  }

  if (load.state === "error") {
    return (
      <Panel>
        <ErrorState title={load.message} onRetry={() => void retry()} inProgress={rereading}>
          {load.outdated ? (
            <div className="grid gap-2">
              <span>Bring it up to date from your workstation, then come back:</span>
              <Command text="sitesolide upgrade" />
            </div>
          ) : (
            <>
              The rest of the dashboard works. Check <code className="font-mono text-xs">systemctl status sitesolide-steward</code> on the server.
            </>
          )}
        </ErrorState>
      </Panel>
    )
  }

  const { view, audit } = load
  if (!view.installed) {
    return (
      <Panel>
        <EmptyState icon={CloudOff} title="Backups aren't set up on this server">
          <div className="grid gap-2 text-left">
            <span>
              Install them from your workstation: run setup again for this server, without <code className="font-mono text-xs">--minimal</code>. It
              takes a first snapshot and turns on the hourly timer.
            </span>
            <Command text="sitesolide setup <user@host> --zone <zone> --email <address>" />
          </div>
        </EmptyState>
      </Panel>
    )
  }

  // A site with nothing to save, and nothing saved: the section says why, and what would change it.
  if (view.excluded !== null && view.snapshots.length === 0) {
    const optedOut = view.excluded.startsWith("opted out")
    return (
      <Panel>
        <EmptyState icon={DatabaseBackup} title={`${slug} isn't backed up`}>
          {optedOut ? (
            <>
              Its <code className="font-mono text-xs">sitesolide.json</code> says <code className="font-mono text-xs">"backup": false</code>.
              To include it, remove that key, then run <code className="font-mono text-xs">sitesolide deploy</code> from its folder.
            </>
          ) : view.excluded === "no data folder" ? (
            <>{slug} has no data folder on the server: it keeps nothing between two deployments.</>
          ) : (
            <>A static site has no data folder: its files come from its repository, and the next deploy puts them back.</>
          )}
        </EmptyState>
      </Panel>
    )
  }

  const restore = view.restore
  const recentFailure =
    restore !== null && (restore.state === "failure" || restore.state === "unknown") && restore.at !== null && serverNow - restore.at < 24 * 3_600_000

  return (
    <>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        The server saves {slug}'s data folder every hour. Restoring puts a snapshot in place of the current data, which is
        saved first, so a restore can be undone. {actions.member ? "It asks you to sign in again with your provider." : "It asks for the dashboard password."}
      </p>

      {actions.unlockNotice !== null && <Banner tone="error">{actions.unlockNotice}</Banner>}

      {restore?.state === "running" && (
        <Banner tone="attention" icon={ArchiveRestore}>
          <span className="font-medium">A restore of {slug} is in progress.</span> {restore.message}
        </Banner>
      )}

      {recentFailure && restore !== null && (
        <Banner tone="error">
          <span className="font-medium">{restoreOutcome(restore, slug).title}.</span> {restore.message}
        </Banner>
      )}

      <SchedulePanel view={view} serverNow={serverNow} />
      <SnapshotsPanel view={view} serverNow={serverNow} onRestore={onRestore} />
      <ActivityPanel slug={slug} audit={audit} serverNow={serverNow} />
    </>
  )
}

/**
 * A site's backups, under `/site/backups/?s=<slug>`: the lock in the header,
 * the schedule, the snapshots with their restore, then the activity.
 */
export function BackupsSection({ slug }: { slug: string }) {
  const { secrets, refresh } = useData()
  const actions = useSecretsActions()
  const backups = useBackups(slug)
  const [opening, setOpening] = useState<Opening | null>(null)
  const openings = useRef(0)

  const view = backups.load.state === "ready" ? backups.load.view : null
  // The lock appears once both have been read: a steward that does not answer would refuse it.
  const headerActions = view !== null && view.installed && secrets.projects !== null ? <SecretsLockControl /> : undefined

  function askRestore(snapshot: SnapshotView) {
    // Locked, the password comes first, and the restore is not replayed after it.
    if (!actions.state.open) return actions.unlock()
    openings.current += 1
    setOpening({ snapshot, opening: openings.current, open: true })
  }

  const onOver = useCallback(() => {
    backups.setFollowing(false)
    // The overview's storage and service follow the new data at the next snapshot: read it now.
    refresh()
  }, [backups, refresh])

  return (
    <>
      <SitePage
        slug={slug}
        section="backups"
        count={view !== null && view.snapshots.length > 0 ? view.snapshots.length : undefined}
        actions={headerActions}
        skeleton={<PanelSkeleton lines={5} />}
      >
        {() => <Content slug={slug} backups={backups} onRestore={askRestore} />}
      </SitePage>
      <RestoreDialog
        slug={slug}
        opening={opening}
        restore={view?.restore ?? null}
        onClose={() => setOpening((before) => before && { ...before, open: false })}
        onStarted={() => {
          backups.setFollowing(true)
          void backups.reload()
        }}
        onLocked={() => {
          setOpening((before) => before && { ...before, open: false })
          secrets.setUnlockedUntil(null)
          actions.unlock()
        }}
        onOver={onOver}
      />
    </>
  )
}
