import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react"
import { Check, CircleCheck, CircleX, Globe, Info, KeyRound, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAnnounce } from "@/components/copy"
import { Banner, INPUT_DIALOG, Panel } from "@/components/page"
import { CodeChip } from "@/components/access-word"
import { Track, type FocusReturn, type OnRefusal } from "@/components/secrets-dialogs"
import { setGeneralAccess } from "@/lib/api"
import {
  addressesLine,
  CHANGE_DURATION,
  DEPLOY_NOTE,
  changeProgress,
  changeResult,
  changeTexts,
  codeWithheld,
  confirmationValid,
  generalLine,
  removalConfirmation,
  type ChangeTarget,
  type ChoiceOption,
  type GeneralReader,
  type GeneralState,
} from "@/lib/access"
import { refusalOf, succeeded } from "@/lib/secrets"
import { TONE_TEXT } from "@/lib/tones"
import type { GeneralAccess } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * General access, the first thing a site's Access section says: how the site
 * opens, the three ways it may, and the change from one to another. All three
 * change here, through the steward and the gatekeeper; a site that opens with
 * a code shows it, its link to copy, and a new one to draw.
 */

// --- The panel ---------------------------------------------------------------------

const ICONS: Record<GeneralAccess, LucideIcon> = { public: Globe, restricted: ShieldCheck, code: KeyRound }

/** The paths a restricted site leaves to the app alone, in the words used everywhere. */
function Exemptions({ paths }: { paths: readonly string[] }) {
  return (
    <p className="text-xs text-pretty text-muted-foreground">
      Open to anyone, guarded by the app alone:{" "}
      {paths.map((path, index) => (
        <span key={path}>
          {index > 0 && " "}
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{path}</code>
        </span>
      ))}
    </p>
  )
}

/** The code in force, to copy or open; or, for whoever may not see it, whom to ask. */
function Code({ slug, state }: { slug: string; state: GeneralState }) {
  if (state.code === null) return <p className="text-xs text-pretty text-muted-foreground">{codeWithheld(slug)}</p>
  return <CodeChip slug={slug} code={state.code.code} url={state.code.url} large />
}

/**
 * The three ways a site opens, the current one marked as the sidebar marks
 * the current page. For the owner and the project's Admins, each other way
 * says what choosing it does, with a button that names the change; the code
 * in force has *New code* beside it. What the steward refuses for one choice
 * is said under it, for all of them once under the choices. Whoever only
 * reads it gets one line. Nothing changes until the confirmation.
 */
export function GeneralAccessPanel({
  slug,
  state,
  options,
  reader,
  renewable,
  stewardReason,
  failedNote,
  addresses,
  onChoose,
}: {
  slug: string
  state: GeneralState
  options: ChoiceOption[]
  reader: GeneralReader
  /** Every address the site answers on: named when there is more than the preview. */
  addresses: string[]
  /** *New code* is offered beside the code in force. */
  renewable: boolean
  /** The steward's reason when no other choice may be taken from here, said once under the choices. */
  stewardReason: string | null
  /** When who has access could not be read: the choices wait for the server. */
  failedNote: string | null
  onChoose: (target: ChangeTarget) => void
}) {
  const problem =
    state.problem === null ? null : (
      <div className="border-b p-3">
        <Banner tone="error">
          <span className="font-medium">{state.problem.title}.</span> {state.problem.detail}
        </Banner>
      </div>
    )

  if (reader === "reader") {
    return (
      <Panel title="General access" full>
        {problem}
        <div className="grid gap-2 px-4 py-3">
          <p className="text-pretty">{generalLine(state, slug)}</p>
          {addressesLine(addresses) !== null && <p className="text-xs text-pretty text-muted-foreground">{addressesLine(addresses)}</p>}
          {state.current === "code" && <Code slug={slug} state={state} />}
          {state.current === "restricted" && state.exemptions.length > 0 && <Exemptions paths={state.exemptions} />}
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="General access" full>
      {problem}
      <ul className="divide-y divide-divider" aria-label={`How ${slug} opens`}>
        {options.map((option) => {
          const Icon = ICONS[option.access]
          return (
            <li
              key={option.access}
              aria-current={option.current ? "true" : undefined}
              className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3", option.current && "shadow-[inset_2px_0_0_var(--primary)]")}
            >
              <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", option.current ? "text-strong" : "text-muted-foreground")} />
              <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                <p className={cn("flex flex-wrap items-center gap-x-2", option.current ? "font-semibold text-strong" : "font-medium")}>
                  {option.title}
                  {option.side !== null ? (
                    <span className="text-xs font-normal text-muted-foreground">{option.side}</span>
                  ) : (
                    option.current && (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <Check aria-hidden="true" className="size-3.5" />
                        Current
                      </span>
                    )
                  )}
                </p>
                <p className="text-pretty text-muted-foreground">{option.sentence}</p>
                {option.current && option.access === "code" && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Code slug={slug} state={state} />
                    {renewable && (
                      <Button variant="outline" size="sm" data-general="renew" onClick={() => onChoose("renew")} className="max-md:h-10">
                        <RefreshCw aria-hidden="true" />
                        New code
                      </Button>
                    )}
                  </div>
                )}
                {option.current && option.access === "restricted" && state.exemptions.length > 0 && (
                  <div className="mt-1">
                    <Exemptions paths={state.exemptions} />
                  </div>
                )}
                {option.reason !== null && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{option.reason}</p>}
              </div>
              {option.available && option.action !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  data-general={option.access}
                  onClick={() => onChoose(option.access)}
                  className="max-md:h-10"
                >
                  {option.action}
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      {addressesLine(addresses) !== null && (
        <p className="flex gap-2 border-t px-4 py-3 text-xs text-pretty text-muted-foreground">
          <Globe aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{addressesLine(addresses)}</span>
        </p>
      )}

      {stewardReason !== null && (
        <p className="flex gap-2 border-t px-4 py-3 text-xs text-pretty text-muted-foreground">
          <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="sr-only">Why it can't change here: </span>
            {stewardReason}
          </span>
        </p>
      )}

      {failedNote !== null && <p className="border-t px-4 py-3 text-xs text-pretty text-muted-foreground">{failedNote}</p>}
    </Panel>
  )
}

// --- The dialog ----------------------------------------------------------------------

export type ChangeState = {
  slug: string
  target: ChangeTarget
  /** How the site opens before the change: leaving a code says the code stops working. */
  from: GeneralAccess
  /** Said before restricting a site nobody is on the list of: who will still open it. */
  warning: string | null
  /** Every address the site answers on, which the change applies to together. */
  addresses: string[]
  open: boolean
  opening: number
}

type Phase =
  | { phase: "confirmation" }
  | { phase: "in-progress"; start: number }
  | { phase: "succeeded"; detail: string; code: { code: string; url: string | null } | null }
  | { phase: "failure"; message: string }

/**
 * A change of general access: a confirmation stating what is about to
 * happen, the slug retyped to make a site public or open it with a code,
 * then the wait, which neither closes nor cancels, and finally the
 * gatekeeper's result in plain words, the code when there is one, and the
 * repository reminder. The form remounts on every opening.
 */
export function GeneralAccessDialog({
  state,
  onClose,
  onChanged,
  onRefusal,
  focusReturn,
}: {
  state: ChangeState | null
  onClose: () => void
  onChanged: (target: ChangeTarget) => void
  onRefusal: OnRefusal
  focusReturn: FocusReturn
}) {
  const busy = useRef(false)
  const typed = state !== null && changeTexts(state.slug, state.target, state.from, state.addresses).typed
  return (
    <Dialog
      open={state?.open ?? false}
      onOpenChange={(next) => {
        if (!next && !busy.current) onClose()
      }}
    >
      <DialogContent finalFocus={focusReturn} showCloseButton={false} className={cn("gap-5 sm:max-w-lg", typed && INPUT_DIALOG)}>
        {state !== null && <ChangeFlow key={state.opening} state={state} busy={busy} onChanged={onChanged} onRefusal={onRefusal} />}
      </DialogContent>
    </Dialog>
  )
}

function ChangeFlow({
  state,
  busy,
  onChanged,
  onRefusal,
}: {
  state: ChangeState
  busy: { current: boolean }
  onChanged: (target: ChangeTarget) => void
  onRefusal: OnRefusal
}) {
  const announce = useAnnounce()
  const { slug, target } = state
  const texts = changeTexts(slug, target, state.from, state.addresses)
  const typed = texts.typed
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
    if (typed && !confirmationValid(entry, slug)) {
      setError(`Type ${slug} to confirm.`)
      return
    }
    setError("")
    setPhase({ phase: "in-progress", start: Date.now() })
    announce(texts.runningTitle)
    const access = target === "renew" ? "code" : target
    const { status, body } = await setGeneralAccess(slug, access, typed ? removalConfirmation(entry) : "", target === "renew")
    if (succeeded(status) && body !== null && typeof body.detail === "string") {
      const detail = changeResult(target, body.detail)
      const code = body.code !== undefined && body.code !== null ? body.code : null
      setPhase({ phase: "succeeded", detail, code })
      // Never through the live region: the code is on screen for whoever asked.
      announce(`${texts.succeeded}. ${detail}`)
      return onChanged(target)
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
        {success && phase.code !== null && (
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">The code</p>
            <div>
              <CodeChip slug={slug} code={phase.code.code} url={phase.code.url} large />
            </div>
            <p className="text-xs text-pretty text-muted-foreground">Send the link: it opens the site and remembers the code for thirty days. It stays shown in Access.</p>
          </div>
        )}
        {success && target !== "renew" && <p className="text-sm text-pretty text-muted-foreground">{DEPLOY_NOTE}</p>}
        <DialogFooter>
          <DialogClose render={<Button ref={closeButton} className="max-sm:h-11" />}>Close</DialogClose>
        </DialogFooter>
      </>
    )
  }

  const inProgress = phase.phase === "in-progress"
  const lead = target === "public" ? `${slug} becomes public.` : `${slug} opens to anyone with its code.`
  return (
    <form noValidate onSubmit={confirm} className="grid gap-5" aria-busy={inProgress || undefined}>
      <DialogHeader>
        <DialogTitle>{inProgress ? texts.runningTitle : texts.title}</DialogTitle>
        {/* What it opens, first and in red, before what it keeps. */}
        {texts.warning !== null && !inProgress && (
          <Banner tone="error">
            <span className="font-medium">{lead}</span> {texts.warning}
          </Banner>
        )}
        <DialogDescription className="text-pretty">{texts.consequence}</DialogDescription>
      </DialogHeader>

      {target === "restricted" && !inProgress && state.warning !== null && <Banner tone="attention">{state.warning}</Banner>}

      <p className="text-xs text-pretty text-muted-foreground">{CHANGE_DURATION}</p>

      {inProgress && <ChangeWait start={phase.start} />}

      {typed && !inProgress && (
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
        {/* A change already under way cannot be cancelled: the gatekeeper sees it through, or rolls back. */}
        {!inProgress && <DialogClose render={<Button type="button" variant="outline" className="max-sm:h-11" />}>Cancel</DialogClose>}
        <Button
          type="submit"
          autoFocus={!typed}
          variant={typed ? "destructive" : "default"}
          disabled={inProgress || (typed && !confirmationValid(entry, slug))}
          className="max-sm:h-11"
        >
          {inProgress ? texts.actionInProgress : texts.action}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The time elapsed, on the scale of the longest answer the relay waits for. */
function ChangeWait({ start }: { start: number }) {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { part, elapsed, slow } = changeProgress(clock - start)
  return (
    <div className="grid gap-2">
      <Track part={part} elapsed={elapsed} usual={null} finish="1.5 min" label={slow ? "Still working, taking longer than usual" : "Waiting for the server"} />
      <p className="text-xs text-pretty text-muted-foreground">
        {slow ? "The server can take a while to apply it. Keep this open: the result always comes." : "Keep this open to see the result."}
      </p>
    </div>
  )
}
