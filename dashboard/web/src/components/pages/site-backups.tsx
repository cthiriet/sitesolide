import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { ArchiveRestore, ChevronDown, CircleCheck, CircleX, Cloud, CloudOff, DatabaseBackup, Info, Server, TriangleAlert, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CHIP } from "@/components/access-word"
import { Command, useAnnounce } from "@/components/copy"
import { useData } from "@/components/data"
import { DataTable, RowMenu, type Column } from "@/components/data-table"
import { SheetFacts, type Fact } from "@/components/detail-sheet"
import {
  Banner,
  EmptyState,
  ErrorState,
  FormError,
  INPUT_DIALOG,
  InlineEmpty,
  Panel,
  PanelSkeleton,
  SeverityIcon,
  Tile,
  useRetry,
} from "@/components/page"
import { WriteButton, WriteMenuItem } from "@/components/unlock"
import { useSecretsActions } from "@/components/secrets-actions"
import { Track, useClock } from "@/components/secrets-dialogs"
import { ON_HOVER } from "@/components/secrets-variables"
import { SitePage } from "@/components/site"
import { readBackups, restoreBackup } from "@/lib/api"
import { confirmationValid, removalConfirmation } from "@/lib/access"
import {
  BACKUPS_REFRESH_MS,
  OUTDATED_STEWARD,
  RESTORE_POLL_MS,
  addedText,
  backupStatus,
  checkReading,
  clockTime,
  kindLabel,
  offsiteReading,
  restoreAct,
  restoreOutcome,
  restoreOver,
  restoreProgress,
  restoreSteps,
  retentionText,
  snapshotMoment,
  snapshotSize,
  snapshotsByDay,
  takenLabel,
  whereLabel,
  type Reading,
} from "@/lib/backups"
import { ago, capitalise, dateTime, plural, size } from "@/lib/format"
import { UNREACHABLE, refusalOf, succeeded } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { BackupsView, RestoreView, SnapshotView } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * A site's backups: one status row, how fresh its last snapshot is and
 * whether the copies are sound, with the rest behind *Details*; then its
 * snapshots, the newest twelve, each restored from its row. The steward
 * reads them as root and decides what may be restored; the page shows its
 * reasons. Their history, the runs and the restores, is in Activity, behind
 * the header's *History*.
 */

type Load = { state: "loading" } | { state: "error"; message: string; outdated: boolean } | { state: "ready"; view: BackupsView }

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
    const { status, body } = await readBackups(slug)
    if (status === 200 && body !== null && typeof body.backups === "object" && body.backups !== null) {
      setLoad({ state: "ready", view: body.backups })
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

// --- The status row --------------------------------------------------------------------

/** A reading in the Details: its words, in its tone when it is wrong and with no dot, the detail muted under it. */
function ReadingValue({ reading }: { reading: Reading }) {
  const trouble = reading.tone === "error" || reading.tone === "attention"
  return (
    <span className="grid gap-0.5">
      <span className={cn(trouble && cn("font-medium", TONE_TEXT[reading.tone]))}>{reading.label}</span>
      {reading.detail !== null && <span className="text-xs text-pretty text-muted-foreground wrap-anywhere">{reading.detail}</span>}
    </span>
  )
}

/**
 * The backups in one row: the last snapshot's age, then the schedule, the
 * offsite copy and the last check, each in its tone when it is wrong; the
 * severity icon in place of the backups' tile when something is. *Details*
 * opens what is kept, where the offsite copy goes, what the check measured
 * and the last restore.
 */
function StatusPanel({ view, serverNow }: { view: BackupsView; serverNow: number }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const status = backupStatus(view, serverNow)
  const trouble = status.tone === "error" || status.tone === "attention"
  const restore = view.restore
  const facts: Fact[] = [
    { label: "Schedule", value: view.excluded === null ? "Every hour" : capitalise(view.excluded) },
    { label: "Keeps", value: retentionText(view.retention) },
    { label: "Offsite copy", value: <ReadingValue reading={offsiteReading(view.offsite)} /> },
    { label: "Last check", value: <ReadingValue reading={checkReading(view.checks, view.repository, serverNow)} /> },
  ]
  if (restore !== null && restore.state !== "running" && restore.at !== null) {
    const outcome = restoreOutcome(restore, view.slug)
    facts.push({
      label: "Last restore",
      value: <ReadingValue reading={{ tone: outcome.tone, label: `${outcome.title}, ${ago(serverNow - restore.at)}`, detail: restore.message }} />,
    })
  }

  return (
    <Panel full>
      <div className="flex min-h-16 items-center gap-3 py-3 pr-2 pl-4">
        {trouble ? (
          <span className="inline-grid size-8 shrink-0 place-items-center">
            <SeverityIcon severity={status.tone === "error" ? "error" : "warning"} label className="size-5" />
          </span>
        ) : (
          <Tile icon={DatabaseBackup} feature="recover" size={32} />
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className={cn("text-sm font-medium text-pretty", trouble ? TONE_TEXT[status.tone] : "text-strong")}>{status.label}</p>
          {status.detail !== null && <p className="text-xs text-pretty text-secondary-foreground wrap-anywhere">{capitalise(status.detail)}</p>}
          <p className="text-xs text-pretty text-muted-foreground">
            {status.facts.map((fact, index) => (
              <span key={fact.text}>
                {index > 0 && <span aria-hidden="true" className="px-1.5 text-faint">·</span>}
                {/* A fact breaks at its separator, never inside: "Offsite copy" stays on one line. */}
                <span className={cn("whitespace-nowrap", fact.tone === "error" && "font-medium text-destructive")}>{fact.text}</span>
                {index < status.facts.length - 1 && <span className="sr-only">, </span>}
              </span>
            ))}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((before) => !before)}
          className="shrink-0 text-muted-foreground hover:text-foreground max-md:h-10"
        >
          Details
          <ChevronDown aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </Button>
      </div>
      <div id={detailsId} hidden={!open} className="border-t px-4 py-1">
        <SheetFacts facts={facts} />
      </div>
    </Panel>
  )
}

// --- The snapshots ---------------------------------------------------------------------

/** The snapshots listed before "Show all": the last twelve hours cover what is usually restored. */
const SHOWN_SNAPSHOTS = 12

/** A line of the table: a snapshot, or, once every snapshot is shown, the day the next ones were taken. */
type Line = { kind: "day"; day: string; count: number } | { kind: "snapshot"; snapshot: SnapshotView; grouped: boolean }

/** One of the two places a snapshot lives, as an icon with its words; an empty place keeps its room, so the icons align. */
function Place({ icon: Icon, present, label }: { icon: LucideIcon; present: boolean; label: string }) {
  if (!present) return <span aria-hidden="true" className="size-4 shrink-0" />
  return (
    <Tooltip>
      <TooltipTrigger render={<span role="img" aria-label={label} className="inline-flex shrink-0 text-muted-foreground" />}>
        <Icon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Where({ snapshot }: { snapshot: SnapshotView }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Place icon={Server} present={snapshot.local} label="On this server" />
      <Place icon={Cloud} present={snapshot.offsite} label="In the offsite copy, encrypted" />
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
  // ones restored, the rest one click away, under their day.
  const [all, setAll] = useState(false)
  const slug = view.slug
  const more = view.snapshots.length > SHOWN_SNAPSHOTS
  const lines: Line[] = all
    ? snapshotsByDay(view.snapshots, serverNow).flatMap(({ day, snapshots }): Line[] => [
        { kind: "day", day, count: snapshots.length },
        ...snapshots.map((snapshot): Line => ({ kind: "snapshot", snapshot, grouped: true })),
      ])
    : view.snapshots.slice(0, SHOWN_SNAPSHOTS).map((snapshot): Line => ({ kind: "snapshot", snapshot, grouped: false }))

  const columns: Column<Line>[] = [
    {
      key: "taken",
      head: "Taken",
      width: "minmax(14rem,1fr)",
      slot: "primary",
      cell: (line) =>
        line.kind === "day" ? (
          <>
            <span className="mono-label text-secondary-foreground">{line.day}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{plural(line.count, "snapshot")}</span>
          </>
        ) : (
          <>
            <time
              dateTime={new Date(line.snapshot.takenAt).toISOString()}
              title={dateTime(line.snapshot.takenAt)}
              className="font-medium whitespace-nowrap text-strong tabular-nums"
            >
              {line.grouped ? clockTime(line.snapshot.takenAt) : takenLabel(line.snapshot.takenAt, serverNow)}
            </time>
            <span className="truncate text-muted-foreground tabular-nums">{ago(serverNow - line.snapshot.takenAt)}</span>
            {line.snapshot.kind !== "scheduled" && <span className={cn(CHIP, "font-normal text-secondary-foreground")}>{kindLabel(line.snapshot.kind)}</span>}
          </>
        ),
    },
    {
      key: "size",
      head: "Size",
      width: "6.5rem",
      align: "end",
      slot: "meta",
      cell: (line) =>
        line.kind === "day" ? null : (
          <span title={addedText(line.snapshot) ?? undefined} className="tabular-nums">
            {size(line.snapshot.bytes)}
          </span>
        ),
    },
    {
      key: "where",
      head: "Where",
      width: "5rem",
      align: "center",
      slot: "state",
      cell: (line) => (line.kind === "day" ? null : <Where snapshot={line.snapshot} />),
    },
  ]
  if (view.restorable) {
    columns.push({
      key: "restore",
      head: "",
      srHead: "Restore",
      width: "7.5rem",
      align: "end",
      slot: "hide",
      cell: (line) =>
        line.kind === "day" ? null : (
          <WriteButton
            variant="outline"
            size="sm"
            onPress={() => onRestore(line.snapshot)}
            purpose={`restore ${slug}`}
            resume="Restore"
            aria-label={`Restore ${slug} from ${dateTime(line.snapshot.takenAt)}`}
            className={ON_HOVER}
          >
            <ArchiveRestore />
            Restore
          </WriteButton>
        ),
    })
  }

  return (
    <Panel full>
      {!view.restorable && view.reason !== null && (
        <InlineEmpty icon={Info} className="border-b">
          <span className="sr-only">Why no restore is offered: </span>
          No restore: {view.reason}.
        </InlineEmpty>
      )}
      <DataTable
        label={`Snapshots of ${slug}`}
        caption={all ? "Every snapshot, newest first, under the day it was taken" : `The newest ${Math.min(SHOWN_SNAPSHOTS, view.snapshots.length)}, newest first`}
        dense
        narrowBelow="36rem"
        rows={lines}
        rowKey={(line) => (line.kind === "day" ? `day ${line.day}` : line.snapshot.name)}
        columns={columns}
        menu={(line) =>
          line.kind === "day" ? null : (
            <RowMenu label={`Actions for the snapshot of ${dateTime(line.snapshot.takenAt)}`}>
              {/* What the row's tooltips say, for a phone that has none. */}
              <div className="grid gap-0.5 px-1.5 py-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{dateTime(line.snapshot.takenAt)}</span>
                <span className="tabular-nums">
                  {snapshotSize(line.snapshot)}, {whereLabel(line.snapshot).toLowerCase()}
                </span>
              </div>
              {view.restorable && (
                <>
                  <DropdownMenuSeparator />
                  <WriteMenuItem onPress={() => onRestore(line.snapshot)} purpose={`restore ${slug}`} resume="Restore">
                    <ArchiveRestore />
                    Restore this snapshot
                  </WriteMenuItem>
                </>
              )}
            </RowMenu>
          )
        }
        foot={
          more ? (
            <Button variant="ghost" size="sm" onClick={() => setAll((before) => !before)} className="-ml-2 text-muted-foreground hover:text-foreground max-md:h-10">
              {all ? `Show the newest ${SHOWN_SNAPSHOTS}` : `Show all ${view.snapshots.length}`}
            </Button>
          ) : undefined
        }
      />
    </Panel>
  )
}

// --- The restore -----------------------------------------------------------------------

type Phase = { phase: "confirmation" } | { phase: "in-progress"; start: number } | { phase: "over"; restore: RestoreView }

type Opening = { snapshot: SnapshotView; opening: number; open: boolean }

function RestoreWait({ start, message }: { start: number; message: string }) {
  const { part, elapsed, slow } = restoreProgress(useClock() - start)
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
  const when = dateTime(snapshot.takenAt)
  // The day and time without the zone, which the title names.
  const moment = snapshotMoment(snapshot.takenAt)

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
        <DialogTitle>{inProgress ? `Restoring ${slug}…` : `Restore ${slug} to ${when}?`}</DialogTitle>
        <DialogDescription className="text-pretty">
          {slug} stops, its data folder is put back as this snapshot holds it, then it starts again.
        </DialogDescription>
      </DialogHeader>

      {!inProgress && (
        <dl className="grid gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <div className="grid gap-0.5">
            <dt className="font-medium">What comes back</dt>
            <dd className="text-pretty text-muted-foreground">
              {snapshot.kind === "pre-restore"
                ? `The data an earlier restore replaced, as it was at ${moment}, ${size(snapshot.bytes)}.`
                : `${slug}'s data folder as it was at ${moment}, ${size(snapshot.bytes)}.`}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="font-medium text-destructive">What is set aside</dt>
            <dd className="text-pretty text-muted-foreground">
              Everything {slug} saved after {moment}, kept as a before-restore snapshot: restore it to undo this. {slug} doesn't
              answer while it restarts.
            </dd>
          </div>
        </dl>
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
          <FormError>{error}</FormError>
        </div>
      )}

      <DialogFooter>
        {/* A restore under way cannot be cancelled: the server sees it through, or puts the data back. */}
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button type="submit" variant="destructive" disabled={inProgress || !confirmationValid(entry, slug)} className="max-sm:h-11">
          {inProgress ? "Restoring…" : restoreAct(slug, snapshot.takenAt)}
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
  const serverNow = now + offset
  const { load, reload } = backups
  const { retrying, retry } = useRetry(reload)

  if (load.state === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading backups" className="grid gap-6">
        {/* The status row, then the snapshots, at the heights of the real ones. */}
        <PanelSkeleton lines={1} title={false} className="[&>div>div]:h-16" />
        <PanelSkeleton lines={6} />
      </div>
    )
  }

  if (load.state === "error") {
    return (
      <Panel>
        <ErrorState title={load.message} onRetry={retry} inProgress={retrying}>
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

  const { view } = load
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

      <StatusPanel view={view} serverNow={serverNow} />
      {/* No snapshot yet: the status row says so, and when the first one comes. */}
      {view.snapshots.length > 0 && <SnapshotsPanel view={view} serverNow={serverNow} onRestore={onRestore} />}
    </>
  )
}

/**
 * A site's backups, under `/site/backups/?s=<slug>`: the status row and its
 * details, then the snapshots with their restore. No activity panel: the
 * runs and the restores are in Activity, behind *History*. A restore asks
 * for the unlock when pressed, then opens its confirmation.
 */
export function BackupsSection({ slug }: { slug: string }) {
  const { secrets, refresh } = useData()
  const actions = useSecretsActions()
  const backups = useBackups(slug)
  const [opening, setOpening] = useState<Opening | null>(null)
  const openings = useRef(0)

  const view = backups.load.state === "ready" ? backups.load.view : null

  /** Unlocked by then: `WriteButton` asked first. The confirmation follows, as before. */
  function askRestore(snapshot: SnapshotView) {
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
        intro={
          view !== null && view.installed ? (
            <p>
              The server saves {slug}'s data folder every hour. Restoring puts a snapshot in place of the current data, which is
              saved first, so a restore can be undone.{" "}
              {actions.person ? "It asks you to sign in again with your provider." : "It asks for the dashboard password."}
            </p>
          ) : undefined
        }
        history={{ target: slug, type: "backups" }}
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
