import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { CircleCheck, CircleX, Info, KeyRound, ShieldCheck, ShieldOff, ShieldX, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Command, useAnnounce } from "@/components/copy"
import { Banner, INPUT_DIALOG, Panel, Status } from "@/components/page"
import { CodeChip } from "@/components/site-access"
import { Track, type FocusReturn, type OnRefusal } from "@/components/secrets-dialogs"
import { togglePortal } from "@/lib/api"
import {
  DEPLOY_COMMAND,
  portalActions,
  portalProgress,
  lockCommands,
  removalConfirmation,
  confirmationValid,
  gatekeeperSteps,
  readPortal,
  toggleTexts,
  type PortalAction,
} from "@/lib/access"
import { refusalOf, succeeded } from "@/lib/secrets"
import { siteAccess } from "@/lib/sites"
import { TONE_TEXT } from "@/lib/tones"
import type { PortalView, Site } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A site's door as seen from its Access section: the portal, which the
 * dashboard can turn on or off by going through the steward and the gatekeeper,
 * and the preview lock, which remains `bin/lock.sh`'s business.
 */

// --- The repository reminder --------------------------------------------------

/** The reminder after an action: the machine has changed, the repository has to follow. */
export function DeployReminder({ slug }: { slug: string }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-pretty">
        <span className="font-medium">Commit the change:</span>{" "}
        <span className="font-mono text-[0.8125rem]">{DEPLOY_COMMAND}</span> in the {slug} folder updates
        sitesolide.json, so the next deploy keeps it.
      </p>
      <Command text={DEPLOY_COMMAND} />
    </div>
  )
}

// --- The portal panel -----------------------------------------------------------

const ICONS: Record<"ok" | "neutral" | "error" | "attention", LucideIcon> = {
  ok: ShieldCheck,
  neutral: ShieldOff,
  attention: ShieldX,
  error: ShieldX,
}

/**
 * A site's portal: its state, the manifest and the Caddy block side by side,
 * the actions the steward accepts or the reason it gives, and the paths the
 * portal leaves public. `portal` comes from the steward; without it, from the
 * snapshot, read only.
 */
export function PortalPanel({
  site,
  portal,
  stewardRead,
  onToggle,
}: {
  site: Site
  portal: PortalView
  /** False until the steward has answered: no action is offered. */
  stewardRead: boolean
  onToggle: (action: PortalAction) => void
}) {
  const reading = readPortal(portal, site.slug)
  const actions = stewardRead ? portalActions(portal) : []
  const Icon = ICONS[reading.tone]
  const error = reading.tone === "error"
  const exemptions = site.portal.exemptions

  return (
    <Panel
      title="Portal"
      full
      actions={
        actions.length === 0 ? undefined : (
          <>
            {actions.map((action) => (
              <Button
                key={String(action.active)}
                data-portal={action.active ? "on" : "off"}
                variant={action.main && action.active ? "default" : "outline"}
                size="sm"
                onClick={() => onToggle(action)}
                className="max-md:h-10"
              >
                {action.active ? <ShieldCheck /> : <ShieldOff />}
                {action.label}
              </Button>
            ))}
          </>
        )
      }
    >
      <div className="grid gap-3 p-4">
        <div className="flex gap-3">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              error ? "text-destructive" : reading.tone === "ok" ? "text-ok-text" : "text-muted-foreground",
            )}
          />
          <div className="grid min-w-0 gap-1">
            <p className={cn("font-medium", error && "text-destructive")}>
              {error && <span className="sr-only">Error: </span>}
              {reading.title}
            </p>
            <p className="text-pretty text-muted-foreground">{reading.detail}</p>
          </div>
        </div>

        {stewardRead && !portal.modifiable && portal.reason !== null && (
          <p className="flex gap-3 text-pretty text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="sr-only">Why it can't change here: </span>
              {portal.reason}
            </span>
          </p>
        )}
      </div>

      <table className="w-full border-t text-sm">
        <caption className="sr-only">The portal, as sitesolide.json asks and as the server applies it</caption>
        <tbody className="divide-y">
          <tr>
            <th
              scope="row"
              className="w-32 py-2.5 pr-3 pl-4 text-left align-top font-normal text-muted-foreground sm:w-40"
            >
              sitesolide.json
            </th>
            <td className="py-2.5 pr-4 pl-3 align-top">{reading.requested}</td>
          </tr>
          <tr>
            <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal text-muted-foreground">
              Server
            </th>
            <td className="py-2.5 pr-4 pl-3 align-top">
              <Status
                tone={reading.checkTone}
                className={cn("whitespace-normal", reading.checkTone === "neutral" && "text-foreground")}
              >
                {reading.applied}
              </Status>
            </td>
          </tr>
          {reading.guards && (
            <tr>
              <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal text-muted-foreground">
                Public paths
              </th>
              <td className="py-2.5 pr-4 pl-3 align-top">
                {exemptions.length === 0 ? (
                  <span>None: every request goes through the portal.</span>
                ) : (
                  <div className="grid gap-1.5">
                    <ul className="flex flex-wrap gap-1.5">
                      {exemptions.map((path) => (
                        <li key={path}>
                          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{path}</code>
                        </li>
                      ))}
                    </ul>
                    <span className="text-xs text-muted-foreground">
                      Guarded by the site alone, set by portalExempt in sitesolide.json.
                    </span>
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  )
}

// --- The lock panel --------------------------------------------------------------

/**
 * The preview lock, read from the snapshot: its code and its link to copy, and
 * the workstation commands that set or remove it. The dashboard does not write
 * there: `bin/lock.sh` generates the code and shows it once.
 */
export function LockPanel({ site }: { site: Site }) {
  const access = siteAccess(site)
  const { closed, code, url } = site.lock
  const commands = lockCommands(site.slug, closed || code !== null)
  const mismatch = access.kind === "mismatch" && (access.key === "code-without-lock" || access.key === "lock-without-code")

  return (
    <Panel title="Preview lock" full>
      <div className="grid gap-3 p-4">
        <div className="flex gap-3">
          <KeyRound
            aria-hidden="true"
            className={cn("mt-0.5 size-4 shrink-0", mismatch ? "text-destructive" : "text-muted-foreground")}
          />
          <div className="grid min-w-0 gap-1">
            <p className={cn("font-medium", mismatch && "text-destructive")}>
              {mismatch && access.kind === "mismatch"
                ? access.label
                : code !== null
                  ? "Locked with a code"
                  : "No preview lock"}
            </p>
            <p className="text-pretty text-muted-foreground">
              {code !== null
                ? "Visitors enter the code once, then their browser remembers it. Send the link: it carries the code."
                : "The preview address answers anyone who knows it. Search engines are kept out, people are not."}
            </p>
          </div>
        </div>
        {code !== null && (
          <div className="pl-7">
            <CodeChip slug={site.slug} code={code} url={url} large />
          </div>
        )}
      </div>
      <div className="grid gap-2 border-t px-4 py-3">
        <p className="text-xs text-pretty text-muted-foreground">
          A preview lock is set from your computer with bin/lock.sh, which makes the code and shows it once. The
          dashboard only shows it.
        </p>
        <ul className="grid gap-2">
          {commands.map((command) => (
            <li key={command.command} className="grid gap-1">
              <span className="text-xs text-muted-foreground">{command.label}</span>
              <Command text={command.command} />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

// --- The dialog ------------------------------------------------------------------

export type ToggleState = { slug: string; active: boolean; open: boolean; opening: number }

type Phase =
  | { phase: "confirmation" }
  | { phase: "in-progress"; start: number }
  | { phase: "succeeded"; detail: string }
  | { phase: "failure"; message: string }

/**
 * Turning the portal on or off: a confirmation stating what is about to
 * happen, the typing of the slug for a removal, which makes the site public,
 * then the wait, which neither closes nor cancels, and finally the
 * gatekeeper's result and the repository reminder. The form remounts on every
 * opening.
 */
export function PortalDialog({
  state,
  onClose,
  onToggled,
  onRefusal,
  focusReturn,
}: {
  state: ToggleState | null
  onClose: () => void
  onToggled: (active: boolean) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const busy = useRef(false)
  return (
    <Dialog
      open={state?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !busy.current) onClose()
      }}
    >
      <DialogContent
        finalFocus={focusReturn}
        showCloseButton={false}
        className={cn("gap-5 sm:max-w-lg", state?.active === false && INPUT_DIALOG)}
      >
        {state !== null && (
          <PortalFlow key={state.opening} state={state} busy={busy} onToggled={onToggled} onRefusal={onRefusal} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PortalFlow({
  state,
  busy,
  onToggled,
  onRefusal,
}: {
  state: ToggleState
  busy: { current: boolean }
  onToggled: (active: boolean) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const { slug, active } = state
  const texts = toggleTexts(slug, active)
  const [phase, setPhase] = useState<Phase>({ phase: "confirmation" })
  const [entry, setEntry] = useState("")
  const [error, setError] = useState("")
  const inputId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    busy.current = phase.phase === "in-progress"
    if (phase.phase === "succeeded" || phase.phase === "failure") closeButton.current?.focus()
  }, [phase, busy])
  useEffect(
    () => () => {
      busy.current = false
    },
    [busy],
  )

  async function confirm(event: SyntheticEvent) {
    event.preventDefault()
    if (phase.phase === "in-progress") return
    if (!active && !confirmationValid(entry, slug)) {
      setError(`Type ${slug} to confirm.`)
      return
    }
    setError("")
    setPhase({ phase: "in-progress", start: Date.now() })
    announce(texts.runningTitle)
    const { status, body } = await togglePortal({
      slug,
      active,
      confirmation: active ? "" : removalConfirmation(entry),
    })
    if (succeeded(status) && body !== null && typeof body.detail === "string") {
      setPhase({ phase: "succeeded", detail: body.detail })
      announce(`${texts.succeeded}. ${body.detail}`)
      return onToggled(active)
    }
    const message = onRefusal(refusalOf(status, body))
    if (message === null) return
    setPhase({ phase: "failure", message })
    announce(`${texts.failure}. ${message}`)
  }

  if (phase.phase === "succeeded" || phase.phase === "failure") {
    const success = phase.phase === "succeeded"
    const Icon = success ? CircleCheck : CircleX
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className={cn("size-5 shrink-0", TONE_TEXT[success ? "ok" : "error"])} />
            {success ? texts.succeeded : texts.failure}
          </DialogTitle>
          <DialogDescription className="text-pretty">{success ? phase.detail : phase.message}</DialogDescription>
        </DialogHeader>
        {success && <DeployReminder slug={slug} />}
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
        <DialogTitle>{inProgress ? texts.runningTitle : texts.title}</DialogTitle>
        <DialogDescription className="text-pretty">{texts.consequence}</DialogDescription>
      </DialogHeader>

      {!active && !inProgress && (
        <Banner tone="error">
          <span className="font-medium">{slug} becomes public.</span> Anyone with its address can open it without
          signing in, from the moment Caddy reloads.
        </Banner>
      )}

      <div className="grid gap-2">
        <p className="text-sm font-medium">What the server does</p>
        <ol className="grid list-decimal gap-1 pl-5 text-sm marker:text-muted-foreground">
          {gatekeeperSteps(slug).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-xs text-pretty text-muted-foreground">
          If any step fails, everything is put back as it was. It can take up to about a minute.
        </p>
      </div>

      {inProgress && <PortalWait start={phase.start} />}

      {!active && !inProgress && (
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
        {/* An action already under way cannot be cancelled: the gatekeeper sees it through, or rolls back. */}
        {!inProgress && (
          <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>
        )}
        <Button
          type="submit"
          autoFocus={active}
          variant={active ? "default" : "destructive"}
          disabled={inProgress || (!active && !confirmationValid(entry, slug))}
          className="max-sm:h-11"
        >
          {inProgress ? texts.actionEnCours : texts.action}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The time elapsed, on the scale of the longest answer the relay waits for. */
function PortalWait({ start }: { start: number }) {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { part, elapsed, slow } = portalProgress(clock - start)
  return (
    <div className="grid gap-2">
      <Track
        part={part}
        elapsed={elapsed}
        usual={null}
        finish="1.5 min"
        label={slow ? "Still working, taking longer than usual" : "Waiting for the server"}
      />
      <p className="text-xs text-pretty text-muted-foreground">
        {slow
          ? "Caddy can take a while to reload. Keep this open: the result always comes."
          : "Keep this open to see the result."}
      </p>
    </div>
  )
}
